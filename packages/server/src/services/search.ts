import { AgentLinkError, type SearchHit } from '@agentlink/protocol';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { isMember, listMyConvIds } from '../db/queries.js';

/**
 * 检索（实现计划 M8，协议 §5.7）。
 *
 * ## 为什么不是「一个 MATCH 打完收工」
 *
 * 数据模型 §2 用 `tokenize='unicode61'`。实测（见 docs/DECISIONS.md）：
 * unicode61 把**一整段连续中文当作一个 token**，所以
 *
 *   text_plain = "周报什么时候交"  → tokens: ["周报什么时候交"]
 *   MATCH '周报'                   → 0 命中
 *
 * 也就是说，只靠 FTS5 无法满足验收 4（"关键词 + 时间范围 + 发送者组合查回"），
 * 因为最常见的中文子串查询根本查不到。文档也承认这点（"对中文是按字切分，
 * 能用但不理想；要更好的中文分词需自建 tokenizer，不在第一版范围"）。
 *
 * ## 取舍（不改协议、不改表结构）
 *
 * 两条查询并集，取 `seq` 最新：
 *   1. **FTS5 路径**：拉丁词、整串精确词命中，用 `snippet()` 出 `<mark>`
 *   2. **CJK 子串路径**：查询串含中日韩字符时，用 `instr()` + `substr()` 做子串
 *      匹配与片段提取 —— 等价于"按字切分"的检索效果
 *
 * 两条路径都不改表、不加 tokenizer，且对拉丁词仍然走 FTS5 索引（快）。
 */

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

const EXCERPT_RADIUS = 40;

export interface SearchInput {
  readonly userId: string;
  readonly q: string;
  readonly convId?: string | undefined;
  readonly fromUserId?: string | undefined;
  readonly before?: number | undefined;
  readonly after?: number | undefined;
  readonly limit?: number | undefined;
}

export function searchMessages(db: Db, input: SearchInput): { hits: SearchHit[] } {
  const q = input.q.trim();
  if (q === '') {
    throw new AgentLinkError('VALIDATION_FAILED', '查询串不能为空', {
      issues: [{ path: 'q', message: '不能为空' }],
    });
  }
  const limit = input.limit ?? 50;

  // 只搜自己可见的会话（协议 §7：请求方不在该群内 → PERM_DENIED）
  const myConvs = listMyConvIds(db, input.userId);
  if (input.convId !== undefined && !isMember(db, input.convId, input.userId)) {
    throw new AgentLinkError('PERM_DENIED', '你不在这个会话里');
  }
  const convScope = input.convId !== undefined ? [input.convId] : myConvs;
  if (convScope.length === 0) return { hits: [] };

  const convList = sql.join(convScope.map((c) => sql`${c}`), sql`, `);

  const filters = sql`
    AND m.conv_id IN (${convList})
    AND m.state = 'final'
    AND m.revoked_at IS NULL
    AND m.seq IS NOT NULL
    ${input.fromUserId === undefined ? sql`` : sql`AND m.sender_id = ${input.fromUserId}`}
    ${input.before === undefined ? sql`` : sql`AND m.created_at < ${input.before}`}
    ${input.after === undefined ? sql`` : sql`AND m.created_at > ${input.after}`}
  `;

  const seen = new Set<string>();
  const out: Array<SearchHit & { sortSeq: number }> = [];

  // ---- 路径 1：FTS5 ----
  // 查询串含空格或特殊字符时，FTS5 语法可能报错；用双引号包成短语，最稳。
  const ftsQuery = `"${q.replace(/"/g, '""')}"`;
  try {
    const rows = db.all<{
      id: string;
      conv_id: string;
      seq: number;
      sender_id: string;
      created_at: number;
      excerpt: string | null;
    }>(sql`
      SELECT m.id, m.conv_id, m.seq, m.sender_id, m.created_at,
             snippet(messages_fts, 0, '<mark>', '</mark>', '…', ${EXCERPT_RADIUS / 4}) AS excerpt
      FROM messages_fts
      JOIN messages m ON m.rowid = messages_fts.rowid
      WHERE messages_fts MATCH ${ftsQuery}
      ${filters}
      ORDER BY m.seq DESC
      LIMIT ${limit}
    `);

    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      const excerpt = (r.excerpt ?? '').trim();
      out.push({
        message_id: r.id,
        conv_id: r.conv_id,
        seq: r.seq,
        sender_id: r.sender_id,
        excerpt: excerpt === '' ? makeExcerptFromPlain(db, r.id, q) : excerpt,
        created_at: r.created_at,
        sortSeq: r.seq,
      });
    }
  } catch {
    // FTS 语法错误（罕见字符组合）不致命：下面的子串路径仍会给出结果
  }

  // ---- 路径 2：CJK / 任意子串 ----
  // instr() 做子串定位，substr() 取前后各约 40 字符，命中词包 <mark>。
  const before = EXCERPT_RADIUS;
  const after = EXCERPT_RADIUS;
  const rows2 = db.all<{
    id: string;
    conv_id: string;
    seq: number;
    sender_id: string;
    created_at: number;
    excerpt: string;
  }>(sql`
    SELECT m.id, m.conv_id, m.seq, m.sender_id, m.created_at,
           (CASE WHEN instr(m.text_plain, ${q}) > 0 THEN
             (CASE WHEN instr(m.text_plain, ${q}) > ${before + 1} THEN '…' ELSE '' END)
             || substr(m.text_plain, max(1, instr(m.text_plain, ${q}) - ${before}),
                       ${before})
             || '<mark>' || ${q} || '</mark>'
             || substr(m.text_plain, instr(m.text_plain, ${q}) + length(${q}), ${after})
             || (CASE WHEN instr(m.text_plain, ${q}) + length(${q}) + ${after} <= length(m.text_plain)
                      THEN '…' ELSE '' END)
           ELSE substr(m.text_plain, 1, ${before * 2}) END) AS excerpt
    FROM messages m
    WHERE instr(m.text_plain, ${q}) > 0
    ${filters}
    ORDER BY m.seq DESC
    LIMIT ${limit}
  `);

  for (const r of rows2) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({
      message_id: r.id,
      conv_id: r.conv_id,
      seq: r.seq,
      sender_id: r.sender_id,
      excerpt: r.excerpt,
      created_at: r.created_at,
      sortSeq: r.seq,
    });
  }

  // 合并后按 seq 倒序（新的在前），截到 limit
  out.sort((x, y) => y.sortSeq - x.sortSeq);
  const hits: SearchHit[] = out.slice(0, limit).map(({ sortSeq: _sortSeq, ...rest }) => rest);
  return { hits };
}

/** FTS 命中但 snippet 为空（例如短语匹配跨块）时，退化成子串片段。 */
function makeExcerptFromPlain(db: Db, messageId: string, q: string): string {
  const row = db.get<{ text_plain: string }>(sql`
    SELECT text_plain FROM messages WHERE id = ${messageId}
  `);
  const text = row?.text_plain ?? '';
  const idx = text.indexOf(q);
  if (idx < 0) return text.slice(0, EXCERPT_RADIUS * 2);
  const start = Math.max(0, idx - EXCERPT_RADIUS);
  const end = Math.min(text.length, idx + q.length + EXCERPT_RADIUS);
  return (
    (start > 0 ? '…' : '') +
    text.slice(start, idx) +
    '<mark>' +
    q +
    '</mark>' +
    text.slice(idx + q.length, end) +
    (end < text.length ? '…' : '')
  );
}

/** 查询串是否含 CJK（决定要不要提示前端分词质量）。 */
export function hasCjk(text: string): boolean {
  return CJK.test(text);
}