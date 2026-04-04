import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WhatsAppInboundMessage } from './channels/whatsapp/types.js';
import { captureWhatsAppMessageToDerivedEvents } from './derived-events.js';

type InboundMessage = {
  id: string;
  senderName: string;
  body: string;
  chatId: string;
  accountId: string;
  replyToJid: string;
  chatType: 'direct' | 'group';
  from: string;
  senderId: string;
  timestamp: number;
  sendComposing: () => Promise<void>;
  reply: () => Promise<void>;
  sendMedia: () => Promise<void>;
};

function createTempSink() {
  const dir = mkdtempSync(join(tmpdir(), 'dexter-derived-events-'));
  const sinkPath = join(dir, 'requests.json');
  let requests: string[] = [];
  return {
    dir,
    sinkPath,
    requests,
    server: Bun.serve({
      port: 0,
      fetch: async (req) => {
        requests.push(await req.text());
        await Bun.write(sinkPath, JSON.stringify(requests, null, 2));
        const url = new URL(req.url);
        if (url.pathname === '/fail') {
          return new Response('upstream deny', { status: 500, headers: { 'content-type': 'text/plain' } });
        }
        if (url.pathname === '/timeout') {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    }),
    get body() {
      return readFileSync(sinkPath, 'utf8');
    },
  };
}

describe('derived-events sandbox harness', () => {
  it('captures direct messages via isolated local sink without touching live dexter state', async () => {
    const sink = createTempSink();

    const inbound = {
      id: 'sandbox-msg-1',
      accountId: 'sandbox-account',
      chatId: 'sandbox-chat',
      replyToJid: 'sandbox-reply',
      chatType: 'direct',
      from: 'sandbox-user',
      senderId: 'sandbox-sender',
      senderName: 'Sandbox User',
      body: '请帮我整理 sandbox rollout',
      timestamp: 1712196900000,
      sendComposing: async () => undefined,
      reply: async () => undefined,
      sendMedia: async () => undefined,
    } as InboundMessage;

    await captureWhatsAppMessageToDerivedEvents({
      inbound,
      sessionKey: 'agent:main:whatsapp:sandbox:direct:sandbox-chat',
      messageText: inbound.body,
      wasMentioned: true,
      config: {
        enabled: true,
        endpoint: `${sink.server.url}ingest`,
        allowChats: ['sandbox-chat'],
        allowSessions: ['agent:main:whatsapp:sandbox:direct:sandbox-chat'],
        requireMentionForGroups: true,
        timeoutMs: 500,
      },
    });

    sink.server.stop(true);
    const body = sink.body;
    expect(body).toContain('sandbox-msg-1');
    expect(body).toContain('sandbox-chat');
    expect(body).toContain('请帮我整理 sandbox rollout');

    rmSync(sink.dir, { recursive: true, force: true });
  });

  it('captures group mention and skips non-mentioned group messages', async () => {
    const sink = createTempSink();

    const inboundMentioned = {
      id: 'sandbox-msg-2',
      accountId: 'sandbox-account',
      chatId: 'sandbox-chat',
      replyToJid: 'sandbox-reply',
      chatType: 'group',
      from: 'sandbox-user',
      senderId: 'sandbox-sender',
      senderName: 'Sandbox Group',
      body: '@bot 把这条任务记到任务清单',
      timestamp: 1712196901000,
      sendComposing: async () => undefined,
      reply: async () => undefined,
      sendMedia: async () => undefined,
    } as InboundMessage;

    await captureWhatsAppMessageToDerivedEvents({
      inbound: inboundMentioned,
      sessionKey: 'agent:main:whatsapp:group:sandbox-chat',
      messageText: inboundMentioned.body,
      wasMentioned: true,
      config: {
        enabled: true,
        endpoint: `${sink.server.url}ingest`,
        allowChats: ['sandbox-chat'],
        allowSessions: ['agent:main:whatsapp:group:sandbox-chat'],
        requireMentionForGroups: true,
        timeoutMs: 500,
      },
    });

    const inboundNotMentioned = {
      id: 'sandbox-msg-3',
      accountId: 'sandbox-account',
      chatId: 'sandbox-chat',
      replyToJid: 'sandbox-reply',
      chatType: 'group',
      from: 'sandbox-user',
      senderId: 'sandbox-sender',
      senderName: 'Sandbox Group',
      body: '这条没提到 @bot',
      timestamp: 1712196902000,
      sendComposing: async () => undefined,
      reply: async () => undefined,
      sendMedia: async () => undefined,
    } as InboundMessage;

    await captureWhatsAppMessageToDerivedEvents({
      inbound: inboundNotMentioned,
      sessionKey: 'agent:main:whatsapp:group:sandbox-chat',
      messageText: inboundNotMentioned.body,
      wasMentioned: false,
      config: {
        enabled: true,
        endpoint: `${sink.server.url}ingest`,
        allowChats: ['sandbox-chat'],
        allowSessions: ['agent:main:whatsapp:group:sandbox-chat'],
        requireMentionForGroups: true,
        timeoutMs: 500,
      },
    });

    sink.server.stop(true);
    const body = sink.body;
    expect(body).toContain('sandbox-msg-2');
    expect(body).not.toContain('sandbox-msg-3');

    rmSync(sink.dir, { recursive: true, force: true });
  });

  it('surfaces non-200s as fail-open without throwing', async () => {
    const sink = createTempSink();

    const inbound = {
      id: 'sandbox-msg-4',
      accountId: 'sandbox-account',
      chatId: 'sandbox-chat',
      replyToJid: 'sandbox-reply',
      chatType: 'direct',
      from: 'sandbox-user',
      senderId: 'sandbox-sender',
      senderName: 'Sandbox User',
      body: 'please continue',
      timestamp: 1712196903000,
      sendComposing: async () => undefined,
      reply: async () => undefined,
      sendMedia: async () => undefined,
    } as InboundMessage;

    await expect(
      captureWhatsAppMessageToDerivedEvents({
        inbound,
        sessionKey: 'agent:main:whatsapp:direct:sandbox-chat',
        messageText: inbound.body,
        wasMentioned: true,
        config: {
          enabled: true,
          endpoint: `${sink.server.url}fail`,
          allowChats: ['sandbox-chat'],
          allowSessions: ['agent:main:whatsapp:direct:sandbox-chat'],
          requireMentionForGroups: true,
          timeoutMs: 500,
        },
      })
    ).resolves.toBeUndefined();

    sink.server.stop(true);
    const body = sink.body;
    expect(body).toContain('sandbox-msg-4');

    rmSync(sink.dir, { recursive: true, force: true });
  });

  it('does not hang when upstream is slow; timeout is fail-open', async () => {
    const sink = createTempSink();

    const inbound = {
      id: 'sandbox-msg-5',
      accountId: 'sandbox-account',
      chatId: 'sandbox-chat',
      replyToJid: 'sandbox-reply',
      chatType: 'direct',
      from: 'sandbox-user',
      senderId: 'sandbox-sender',
      senderName: 'Sandbox User',
      body: 'slow path should timeout',
      timestamp: 1712196904000,
      sendComposing: async () => undefined,
      reply: async () => undefined,
      sendMedia: async () => undefined,
    } as InboundMessage;

    await expect(
      captureWhatsAppMessageToDerivedEvents({
        inbound,
        sessionKey: 'agent:main:whatsapp:direct:sandbox-chat',
        messageText: inbound.body,
        wasMentioned: true,
        config: {
          enabled: true,
          endpoint: `${sink.server.url}timeout`,
          allowChats: ['sandbox-chat'],
          allowSessions: ['agent:main:whatsapp:direct:sandbox-chat'],
          requireMentionForGroups: true,
          timeoutMs: 100,
        },
      })
    ).resolves.toBeUndefined();

    sink.server.stop(true);
    const body = sink.body;
    expect(body).toContain('sandbox-msg-5');

    rmSync(sink.dir, { recursive: true, force: true });
  });

  it('remains fail-open when isolated sink is unavailable', async () => {
    const inbound = {
      id: 'sandbox-msg-6',
      accountId: 'sandbox-account',
      chatId: 'sandbox-chat',
      replyToJid: 'sandbox-reply',
      chatType: 'direct',
      from: 'sandbox-user',
      senderId: 'sandbox-sender',
      senderName: 'Sandbox User',
      body: 'this should not break runtime',
      timestamp: 1712196905000,
      sendComposing: async () => undefined,
      reply: async () => undefined,
      sendMedia: async () => undefined,
    } as InboundMessage;

    await expect(
      captureWhatsAppMessageToDerivedEvents({
        inbound,
        sessionKey: 'agent:main:whatsapp:sandbox:direct:sandbox-chat',
        messageText: inbound.body,
        wasMentioned: true,
        config: {
          enabled: true,
          endpoint: 'http://127.0.0.1:9/ingest',
          allowChats: ['sandbox-chat'],
          allowSessions: ['agent:main:whatsapp:sandbox:direct:sandbox-chat'],
          requireMentionForGroups: true,
          timeoutMs: 200,
        },
      })
    ).resolves.toBeUndefined();
  });
});
