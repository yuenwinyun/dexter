import { describe, expect, it } from 'bun:test';
import type { WhatsAppInboundMessage } from './channels/whatsapp/types.js';
import {
  buildDerivedEventEnvelope,
  captureWhatsAppMessageToDerivedEvents,
} from './derived-events.js';

describe('buildDerivedEventEnvelope', () => {
  it('builds normalized envelope for whatsapp direct message', () => {
    const inbound = {
      accountId: 'acc-1',
      chatId: 'chat-direct',
      replyToJid: 'reply-jid',
      chatType: 'direct',
      from: 'from-user',
      senderId: 'sender-1',
      senderName: 'Alice',
      body: '帮我下周整理 derived event',
      id: 'msg-1',
      sendComposing: async () => undefined,
      reply: async () => undefined,
      sendMedia: async () => undefined,
      timestamp: 1712000000000,
    } as WhatsAppInboundMessage;

    const envelope = buildDerivedEventEnvelope({
      source: 'whatsapp',
      inbound,
      sessionKey: 'agent:main:whatsapp:direct',
      messageText: '帮我下周整理 derived event',
      wasMentioned: true,
    });

    expect(envelope.source).toBe('whatsapp');
    expect(envelope.chat_type).toBe('direct');
    expect(envelope.chat_id).toBe('chat-direct');
    expect(envelope.session_key).toBe('agent:main:whatsapp:direct');
    expect(envelope.message_id).toBe('msg-1');
    expect(envelope.sender_name).toBe('Alice');
    expect(envelope.was_mentioned).toBe(true);
    expect(envelope.text).toBe('帮我下周整理 derived event');
    expect(envelope.created_at).toBe(new Date(1712000000000).toISOString());
  });
});

describe('captureWhatsAppMessageToDerivedEvents', () => {
  it('is fail-open when disabled', async () => {
    let requested = false;
    const originalFetch = globalThis.fetch;
    // @ts-expect-error test stub for safe override
    globalThis.fetch = async () => {
      requested = true;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    await captureWhatsAppMessageToDerivedEvents({
      inbound: {
        accountId: 'acc-1',
        chatId: 'chat-direct',
        replyToJid: 'reply-jid',
        chatType: 'direct',
        from: 'from-user',
        senderId: 'sender-1',
        body: 'ignore this',
        sendComposing: async () => undefined,
        reply: async () => undefined,
        sendMedia: async () => undefined,
      } as WhatsAppInboundMessage,
      sessionKey: 'agent:main:whatsapp:direct',
      messageText: 'ignore this',
      wasMentioned: true,
      config: { enabled: false },
    });
    expect(requested).toBe(false);
    globalThis.fetch = originalFetch;
  });

  it('posts envelope and swallows network errors', async () => {
    const inbound = {
      accountId: 'acc-1',
      chatId: 'chat-direct',
      replyToJid: 'reply-jid',
      chatType: 'direct',
      from: 'from-user',
      senderId: 'sender-1',
      body: 'please create todo',
      sendComposing: async () => undefined,
      reply: async () => undefined,
      sendMedia: async () => undefined,
    } as WhatsAppInboundMessage;

    const originalFetch = globalThis.fetch;
    // @ts-expect-error test stub for safe override
    globalThis.fetch = async (url: string) => {
      if (url.includes('bad')) {
        throw new Error('network down');
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    // Should not throw even when endpoint is failing.
    await expect(
      captureWhatsAppMessageToDerivedEvents({
        inbound,
        sessionKey: 'agent:main:whatsapp:direct',
        messageText: 'please create todo',
        wasMentioned: true,
        config: {
          enabled: true,
          endpoint: 'http://bad-host.invalid/ingest',
          allowChats: [],
          allowSessions: [],
          requireMentionForGroups: true,
          timeoutMs: 200,
        },
      })
    ).resolves.toBeUndefined();

    globalThis.fetch = originalFetch;
  });
});
