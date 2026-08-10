import { getApiBase } from '../api/client';

export type ServerMsgType =
  | 'session_started'
  | 'question'
  | 'follow_up'
  | 'status'
  | 'done';

export interface ServerMsg {
  type: ServerMsgType;
  content?: string;
  progress?: {
    current: number;
    total: number;
  };
}

function wsOriginFromApiBase(apiBase: string): string {
  const url = new URL(apiBase);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.origin;
}

export function connectInterviewWS(
  id: number,
  token: string,
  handlers: {
    onMessage(msg: ServerMsg): void;
    onClose(): void;
  },
): { sendAnswer(content: string): void; close(): void } {
  const origin = wsOriginFromApiBase(getApiBase());
  const wsUrl = `${origin}/ws/interviews/${id}?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(wsUrl);

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data as string) as ServerMsg;
      handlers.onMessage(msg);
    } catch {
      // ignore malformed messages
    }
  };

  ws.onclose = () => {
    handlers.onClose();
  };

  return {
    sendAnswer(content: string) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'answer', content }));
      }
    },
    close() {
      ws.close();
    },
  };
}
