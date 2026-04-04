import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WhatsAppInboundMessage } from './channels/whatsapp/types.js';
import { captureWhatsAppMessageToDerivedEvents } from './derived-events.js';

describe('derived-events sandbox harness', () => {
  it('writes captured request to isolated local sink without touching live dexter state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dexter-derived-events-'));
    const sinkPath = join(dir, 'requests.json');
    let requests: string[] = [];

    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        requests.push(await req.text());
        await Bun.write(sinkPath, JSON.stringify(requests, null, 2));
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

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
    } as WhatsAppInboundMessage;

    await captureWhatsAppMessageToDerivedEvents({
      inbound,
      sessionKey: 'agent:main:whatsapp:sandbox:direct:sandbox-chat',
      messageText: inbound.body,
      wasMentioned: true,
      config: {
        enabled: true,
        endpoint: `${server.url}ingest`,
        allowChats: ['sandbox-chat'],
        allowSessions: ['agent:main:whatsapp:sandbox:direct:sandbox-chat'],
        requireMentionForGroups: true,
        timeoutMs: 500,
      },
    });

    server.stop(true);

    const body = readFileSync(sinkPath, 'utf8');
    expect(body).toContain('sandbox-msg-1');
    expect(body).toContain('sandbox-chat');
    expect(body).toContain('请帮我整理 sandbox rollout');

    rmSync(dir, { recursive: true, force: true });
  });

  it('remains fail-open when isolated sink is unavailable', async () => {
    const inbound = {
      id: 'sandbox-msg-2',
      accountId: 'sandbox-account',
      chatId: 'sandbox-chat',
      replyToJid: 'sandbox-reply',
      chatType: 'direct',
      from: 'sandbox-user',
      senderId: 'sandbox-sender',
      senderName: 'Sandbox User',
      body: 'this should not break runtime',
      timestamp: 1712196901000,
      sendComposing: async () => undefined,
      reply: async () => undefined,
      sendMedia: async () => undefined,
    } as WhatsAppInboundMessage;

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
