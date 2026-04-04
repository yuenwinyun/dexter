import type { WhatsAppInboundMessage } from './channels/whatsapp/types.js';
import { getSetting } from '../utils/config.js';

const DEFAULT_INGRESS_ENDPOINT = 'http://127.0.0.1:8080/ingest';

export type MessageDerivedEventsConfig = {
  enabled: boolean;
  endpoint: string;
  allowChats: string[];
  allowSessions: string[];
  requireMentionForGroups: boolean;
  timeoutMs: number;
};

export type DerivedEventsEnvelope = {
  source: 'whatsapp' | 'feishu';
  chat_type: 'group' | 'direct';
  chat_id: string;
  session_key: string;
  message_id: string;
  sender_id: string;
  sender_name: string;
  was_mentioned: boolean;
  reply_to_message_id: string;
  text: string;
  reply_context_text: string;
  role: 'user';
  created_at: string;
};

export type Logger = (msg: string, err?: unknown) => void;

export function getDefaultMessageDerivedEventsConfig(): MessageDerivedEventsConfig {
  const allowChats = parseStringList(getSetting<unknown>('messageDerivedEventsAllowChats', []));
  const allowSessions = parseStringList(getSetting<unknown>('messageDerivedEventsAllowSessions', []));
  const rawTimeout = Number(getSetting('messageDerivedEventsTimeoutMs', 1500));
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? Math.floor(rawTimeout) : 1500;
  return {
    enabled: getSetting('messageDerivedEventsEnabled', false),
    endpoint: getSetting('messageDerivedEventsEndpoint', DEFAULT_INGRESS_ENDPOINT),
    allowChats,
    allowSessions,
    requireMentionForGroups: getSetting('messageDerivedEventsRequireMentionForGroups', true),
    timeoutMs,
  };
}

export function buildDerivedEventEnvelope(input: {
  source: DerivedEventsEnvelope['source'];
  inbound: WhatsAppInboundMessage;
  sessionKey: string;
  messageText: string;
  wasMentioned: boolean;
}): DerivedEventsEnvelope {
  const { inbound, sessionKey, messageText, source, wasMentioned } = input;
  const chatType = inbound.chatType;
  const messageId = inbound.id || `whatsapp-${inbound.chatId}-${inbound.senderId}-${Date.now()}`;

  return {
    source,
    chat_type: chatType,
    chat_id: inbound.chatId,
    session_key: sessionKey,
    message_id: messageId,
    sender_id: inbound.senderId,
    sender_name: inbound.senderName || inbound.senderId,
    was_mentioned: wasMentioned,
    reply_to_message_id: '',
    text: messageText || inbound.body,
    reply_context_text: '',
    role: 'user',
    created_at: inbound.timestamp ? new Date(inbound.timestamp).toISOString() : new Date().toISOString(),
  };
}

export async function captureWhatsAppMessageToDerivedEvents(input: {
  inbound: WhatsAppInboundMessage;
  sessionKey: string;
  messageText: string;
  wasMentioned: boolean;
  logger?: Logger;
  config?: Partial<MessageDerivedEventsConfig>;
}): Promise<void> {
  const config = { ...getDefaultMessageDerivedEventsConfig(), ...(input.config || {}) };
  const logger = input.logger ?? (() => undefined);

  if (!config.enabled) {
    return;
  }

  if (config.allowChats.length > 0 && !config.allowChats.includes(input.inbound.chatId)) {
    return;
  }

  if (config.allowSessions.length > 0 && !config.allowSessions.includes(input.sessionKey)) {
    return;
  }

  const chatMessage = buildDerivedEventEnvelope({
    source: 'whatsapp',
    inbound: input.inbound,
    sessionKey: input.sessionKey,
    messageText: input.messageText,
    wasMentioned: input.wasMentioned,
  });

  if (chatMessage.chat_type === 'group' && config.requireMentionForGroups && !chatMessage.was_mentioned) {
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(300, config.timeoutMs));
  try {
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(chatMessage),
      signal: controller.signal,
    });
    if (!response.ok) {
      logger(`message-derived-events ingress rejected: ${response.status} ${response.statusText}`);
    }
  } catch (err) {
    logger('message-derived-events ingress failed (non-fatal)', err);
  } finally {
    clearTimeout(timeout);
  }
}

function parseStringList(value: unknown): string[] {
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter((item) => item.length > 0);
  }

  return [];
}
