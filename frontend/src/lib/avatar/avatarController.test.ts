import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AvatarSpeechStopped,
  createAvatarController,
  type AvatarController,
  type AvatarEngine,
} from './avatarController';

/** 构造可控的假引擎 */
function makeFakeEngine(opts?: {
  decodeError?: boolean;
  speakError?: boolean;
}): AvatarEngine {
  let markerCb: (() => void) | null = null;
  void markerCb;
  const head = {
    audioCtx: {
      decodeAudioData: async () => {
        if (opts?.decodeError) throw new Error('decode failed');
        return {} as AudioBuffer;
      },
      close: async () => undefined,
    },
    speakAudio: () => {
      if (opts?.speakError) throw new Error('enqueue failed');
    },
    speakMarker: async (cb: () => void) => {
      markerCb = cb;
    },
    stopSpeaking: () => {
      markerCb = null;
    },
    start: () => {},
    stop: () => {},
  };
  return {
    head: head as unknown as AvatarEngine['head'],
    headaudio: null,
  };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function statusOf(ctrl: AvatarController): string {
  return ctrl.getStatus();
}

/** mock WebGL 可用（controller 用临时 canvas 探测） */
function mockWebGL() {
  return vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue({} as never);
}

describe('avatarController', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('WebGL 不可用时直接失败降级，不初始化引擎', async () => {
    const factory = vi.fn();
    const ctrl = createAvatarController(factory);
    const container = document.createElement('div');
    // jsdom 默认无 WebGL 实现（临时探测 canvas 拿不到 context）
    await ctrl.init(container);
    expect(statusOf(ctrl)).toBe('failed');
    expect(ctrl.getErrorMessage()).toContain('纯语音');
    expect(factory).not.toHaveBeenCalled();
  });

  it('引擎工厂抛错时降级失败，speak 回落 fallback', async () => {
    const ctrl = createAvatarController(async () => {
      throw new Error('engine init failed');
    });
    const container = document.createElement('div');
    mockWebGL();
    await ctrl.init(container);
    expect(statusOf(ctrl)).toBe('failed');
    await expect(ctrl.speak(new Blob(['x']))).resolves.toBe('fallback');
  });

  it('初始化成功后 speak 走数字人路径并等待播完', async () => {
    let resolveMarker: (() => void) | null = null;
    const engine = makeFakeEngine();
    (engine.head as unknown as {
      speakMarker: (cb: () => void) => Promise<void>;
    }).speakMarker = async (cb: () => void) => {
      resolveMarker = cb;
    };

    const ctrl = createAvatarController(async () => engine);
    const container = document.createElement('div');
    mockWebGL();
    await ctrl.init(container);
    expect(statusOf(ctrl)).toBe('ready');

    const blob = new Blob(['x']);
    const p = ctrl.speak(blob);
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await flushMicrotasks();
    expect(settled).toBe(false); // marker 未触发前不 resolve
    (resolveMarker as (() => void) | null)?.();
    await expect(p).resolves.toBe('avatar');
    expect(settled).toBe(true);
  });

  it('stop() 打断等待中的 speak：抛 AvatarSpeechStopped', async () => {
    const engine = makeFakeEngine();
    // marker 永不触发（覆盖为空实现）
    (engine.head as unknown as {
      speakMarker: () => Promise<void>;
    }).speakMarker = async () => {};
    const ctrl = createAvatarController(async () => engine);
    const container = document.createElement('div');
    mockWebGL();
    await ctrl.init(container);

    const p = ctrl.speak(new Blob(['x']));
    await flushMicrotasks();
    ctrl.stop();
    await expect(p).rejects.toBeInstanceOf(AvatarSpeechStopped);
  });

  it('decodeAudioData 失败时（入队前）安全回落 fallback', async () => {
    const engine = makeFakeEngine({ decodeError: true });
    const ctrl = createAvatarController(async () => engine);
    const container = document.createElement('div');
    mockWebGL();
    await ctrl.init(container);
    await expect(ctrl.speak(new Blob(['x']))).resolves.toBe('fallback');
  });

  it('speakAudio 入队抛错时回落 fallback', async () => {
    const engine = makeFakeEngine({ speakError: true });
    const ctrl = createAvatarController(async () => engine);
    const container = document.createElement('div');
    mockWebGL();
    await ctrl.init(container);
    await expect(ctrl.speak(new Blob(['x']))).resolves.toBe('fallback');
  });

  it('subscribe 收到状态变化通知，dispose 后状态回到 idle', async () => {
    const engine = makeFakeEngine();
    const ctrl = createAvatarController(async () => engine);
    const container = document.createElement('div');
    mockWebGL();
    const events: string[] = [];
    const unsubscribe = ctrl.subscribe((s) => events.push(s));
    await ctrl.init(container);
    expect(events).toEqual(['loading', 'ready']);
    ctrl.dispose();
    expect(statusOf(ctrl)).toBe('idle');
    unsubscribe();
  });
});
