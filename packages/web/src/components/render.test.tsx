import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LoginView } from './LoginView.js';
import { ConversationList } from './ConversationList.js';
import { ChatWindow } from './ChatWindow.js';
import { MemberPanel } from './MemberPanel.js';
import type { Conversation, Member, Message } from '@agentlink/protocol';

/**
 * 渲染层冒烟测试：确认组件真的能挂到 DOM 上并画出关键内容。
 *
 * 无头浏览器在本环境跑不起来（snap 的 Firefox 需要可写的 HOME），
 * 所以用 jsdom 做真实渲染，配合 m6.mjs 里的状态逻辑探针。
 */

const conv: Conversation = {
  id: 'c_01M7JD0000000000000000000A',
  kind: 'group',
  title: '测试群',
  announcement: '',
  created_by: 'u_a',
  created_at: Date.now(),
};

const msg = (id: string, text: string, self: boolean): Message => ({
  id,
  conv_id: conv.id,
  seq: 1,
  sender: {
    id: self ? 'u_a' : 'u_b',
    kind: self ? 'human' : 'agent',
    display_name: self ? '我' : '助手',
  },
  content: [{ type: 'text', text }],
  reply_to: null,
  state: 'final',
  interrupted: false,
  created_at: Date.now(),
  revoked_at: null,
});

const member = (id: string, name: string, role: Member['role'] = 'member'): Member => ({
  conv_id: conv.id,
  user_id: id,
  role,
  is_agent: false,
  muted_until: 0,
  joined_at: Date.now(),
  user: { id, kind: 'human', display_name: name },
});

describe('渲染冒烟', () => {
  it('登录页画出表单与产品名', () => {
    render(<LoginView onDone={() => {}} />);
    expect(screen.getByRole('heading', { name: 'AgentLink' })).toBeTruthy();
    expect(screen.getByLabelText('用户名')).toBeTruthy();
    expect(screen.getByLabelText('口令')).toBeTruthy();
    expect(screen.getByRole('button', { name: '登录' })).toBeTruthy();
  });

  it('会话列表画出会话标题与最后一条消息预览', () => {
    render(
      <ConversationList
        convs={[conv]}
        activeConvId={conv.id}
        messages={{ [conv.id]: [msg('m1', '最后一条预览', true)] }}
        onSelect={() => {}}
        onNewGroup={() => {}}
        selfName="我"
        onLogout={() => {}}
      />,
    );
    expect(screen.getByText('测试群')).toBeTruthy();
    expect(screen.getByText('最后一条预览')).toBeTruthy();
  });

  it('聊天窗画出消息气泡、昵称与 agent 标记', () => {
    render(
      <ChatWindow
        convTitle="测试群"
        messages={[msg('m1', '来自助手的话', false)]}
        streaming={{}}
        selfId="u_a"
        members={[member('u_a', '我', 'owner'), member('u_b', '助手')]}
        onSend={() => {}}
        onRevoke={() => {}}
        onInterrupt={() => {}}
        onLoadMore={() => {}}
        hasMore={false}
        loadingMore={false}
        onToggleMembers={() => {}}
        canRevokeOthers
      />,
    );
    expect(screen.getByText('来自助手的话')).toBeTruthy();
    expect(screen.getByText('助手')).toBeTruthy();
    expect(screen.getByText('agent')).toBeTruthy();
    expect(screen.getByText('2 位成员')).toBeTruthy();
    expect(screen.getByPlaceholderText(/写消息/)).toBeTruthy();
  });

  it('流式消息渲染出逐字增长的文本', () => {
    const streamingMsg: Message = { ...msg('m2', '', false), state: 'streaming', seq: null };
    render(
      <ChatWindow
        convTitle="测试群"
        messages={[streamingMsg]}
        streaming={{ m2: { text: '正在生成' } }}
        selfId="u_a"
        members={[member('u_a', '我', 'owner')]}
        onSend={() => {}}
        onRevoke={() => {}}
        onInterrupt={() => {}}
        onLoadMore={() => {}}
        hasMore={false}
        loadingMore={false}
        onToggleMembers={() => {}}
        canRevokeOthers={false}
      />,
    );
    expect(screen.getByText('正在生成')).toBeTruthy();
  });

  it('成员面板画出成员与角色，admin 能看到管理按钮', () => {
    render(
      <MemberPanel
        members={[member('u_a', '我', 'owner'), member('u_b', '小明')]}
        selfId="u_a"
        myRole="owner"
        onKick={() => {}}
        onMute={() => {}}
        onSetRole={() => {}}
        onInvite={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/成员 2/)).toBeTruthy();
    expect(screen.getByText('群主')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '踢出' }).length).toBe(1);
    expect(screen.getByRole('button', { name: '邀请成员' })).toBeTruthy();
  });
});