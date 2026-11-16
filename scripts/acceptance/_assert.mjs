#!/usr/bin/env node
/**
 * 验收断言工具。故意极简：失败就抛，抛了整轮验收就红。
 */

let passed = 0;
let failed = 0;
const failures = [];

export function ok(cond, label) {
  if (cond) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  \x1b[31m✗ ${label}\x1b[0m`);
  }
  return Boolean(cond);
}

export function eq(actual, expected, label) {
  const same = Object.is(actual, expected);
  if (!same) {
    console.log(`      期望: ${fmt(expected)}`);
    console.log(`      实际: ${fmt(actual)}`);
  }
  return ok(same, label);
}

export function deepEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    console.log(`      期望: ${b}`);
    console.log(`      实际: ${a}`);
  }
  return ok(a === b, label);
}

export function gt(actual, threshold, label) {
  return ok(actual > threshold, `${label} (${actual} > ${threshold})`);
}

export function gte(actual, threshold, label) {
  return ok(actual >= threshold, `${label} (${actual} >= ${threshold})`);
}

export function lte(actual, threshold, label) {
  return ok(actual <= threshold, `${label} (${actual} <= ${threshold})`);
}

export function includes(haystack, needle, label) {
  const has = typeof haystack === 'string' ? haystack.includes(needle) : haystack.includes(needle);
  if (!has) console.log(`      未包含: ${fmt(needle)}`);
  return ok(has, label);
}

function fmt(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  return JSON.stringify(v);
}

/** 断言 res 是成功的，返回 data。 */
export function expectOk(res, label) {
  if (res?.ok === true) {
    ok(true, label ?? '响应成功');
    return res.data;
  }
  ok(false, `${label ?? '响应成功'}（实际错误: ${res?.error?.code} ${res?.error?.message}）`);
  throw new Error(`期望成功响应，收到 ${JSON.stringify(res?.error)}`);
}

/** 断言 res 是失败的且 code 匹配，返回 error。 */
export function expectError(res, code, label) {
  if (res?.ok === false && res.error?.code === code) {
    ok(true, label ?? `错误码 ${code}`);
    return res.error;
  }
  const got = res?.ok === false ? res.error?.code : `ok=true`;
  ok(false, `${label ?? `错误码 ${code}`}（实际: ${got}）`);
  throw new Error(`期望错误码 ${code}，收到 ${JSON.stringify(res)}`);
}

/** 断言是失败的，但不限定具体 code（用于宽松校验）。 */
export function expectAnyError(res, label) {
  if (res?.ok === false) {
    ok(true, label ?? `返回错误 ${res.error?.code}`);
    return res.error;
  }
  ok(false, `${label ?? '返回错误'}（实际成功）`);
  throw new Error('期望错误响应，收到成功');
}

export function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

export function summary(name) {
  console.log('');
  if (failed === 0) {
    console.log(`\x1b[32m\x1b[1m${name} 通过\x1b[0m — ${passed} 项断言全部成功`);
    return 0;
  }
  console.log(`\x1b[31m\x1b[1m${name} 失败\x1b[0m — ${failed} 项失败 / ${passed + failed} 项`);
  for (const f of failures) console.log(`  - ${f}`);
  return 1;
}

export function counters() {
  return { passed, failed };
}
