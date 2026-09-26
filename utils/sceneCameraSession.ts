/**
 * Scene Camera Session (Phase 3C)
 *
 * 职责：SceneCameraModal 的无头状态机。UI 组件保持轻量，流程语义在这里集中并可测试：
 * - generate()          ：Director + Renderer 完整流程（两阶段 phase：directing → rendering）
 * - rerenderSameShot()  ：保留当前 ShotPlan，只重新调用 Renderer（允许换生图模型）
 * - redirectNewShot()   ：重新调用 Director，并把当前 ShotPlan 作为 previousShotPlan 传入差异化
 * - retry()             ：有 ShotPlan 时等价于重拍同一镜头，否则重新完整生成
 *
 * 不写聊天、不写长期记忆、不新增 DB 表；上一张图片不进入下一次 Visual Identity references
 * （references 只由 imageGenerationService 基于 characterId 从 active preset 读取）。
 */

import type {
  CharacterProfile,
  ImageGenerationAspectRatio,
  ImageGenerationConfig,
  SceneCameraMode,
  SceneCameraShotPlan,
} from '../types';
import type { DirectorApiConfig } from './sceneCameraPrompt';
import { generateShotPlanOnly, renderShotPlan } from './sceneCameraService';

/** 两阶段加载：Director 理解场景 → Renderer 成像。 */
export type SceneCameraPhase = 'idle' | 'directing' | 'rendering' | 'done' | 'error';

export interface SceneCameraMetadata {
  provider: string;
  model: string;
}

export interface SceneCameraSessionState {
  mode: SceneCameraMode;
  phase: SceneCameraPhase;
  aspectRatio?: ImageGenerationAspectRatio;
  /** 当前 ShotPlan（Renderer 失败后仍保留，供「重拍同一镜头 / 重试」） */
  shotPlan?: SceneCameraShotPlan;
  /** 上一次成功方案（重新导演时的差异化来源，仅 metadata，不携带图片） */
  previousShotPlan?: SceneCameraShotPlan;
  imageUrl?: string;
  error?: string;
  directorMetadata?: SceneCameraMetadata;
  rendererMetadata?: SceneCameraMetadata;
}

/** 第一版支持的摄影模式（pov-selfie / creative-director 暂不实现）。 */
export const SUPPORTED_SCENE_CAMERA_MODES: readonly SceneCameraMode[] = ['scene-snapshot', 'duo-photo'];

/** 第一版暴露的宽高比（受现有 ImageGenerationAspectRatio 枚举约束，暂无 4:5）。 */
export const SCENE_CAMERA_ASPECT_RATIOS: readonly ImageGenerationAspectRatio[] = ['1:1', '4:3', '3:4', '9:16', '16:9'];

export const INITIAL_SCENE_CAMERA_SESSION_STATE: SceneCameraSessionState = {
  mode: 'scene-snapshot',
  phase: 'idle',
};

export interface SceneCameraSessionDeps {
  /** 最小必要场景上下文（陪伴 / 剧情各自由 sceneCameraContext 提供） */
  getSceneContext: () => string;
  getCharacter: () => CharacterProfile;
  /** Director 默认复用当前聊天 API config */
  getDirectorConfig: () => DirectorApiConfig;
  /** Renderer 每次动作前重新读取现有生图配置（允许用户中途换模型） */
  getRendererConfig: () => ImageGenerationConfig;
  /** 注入点（默认接 Phase 3B service，测试可替换） */
  requestShotPlan?: typeof generateShotPlanOnly;
  renderExistingShotPlan?: typeof renderShotPlan;
  /** debug 日志开关（仅必要信息：mode / provider / model / 镜头参数，不含 Key 与完整上下文） */
  debug?: boolean;
}

export class SceneCameraSession {
  private state: SceneCameraSessionState = { ...INITIAL_SCENE_CAMERA_SESSION_STATE };
  private readonly listeners = new Set<() => void>();
  private busy = false;
  private controller: AbortController | null = null;

  constructor(private readonly deps: SceneCameraSessionDeps) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  getState(): SceneCameraSessionState {
    return this.state;
  }

  isBusy(): boolean {
    return this.busy;
  }

  setMode(mode: SceneCameraMode): void {
    if (!SUPPORTED_SCENE_CAMERA_MODES.includes(mode)) return;
    if (this.busy) return;
    this.patch({ mode });
  }

  setAspectRatio(aspectRatio: ImageGenerationAspectRatio): void {
    if (this.busy) return;
    this.patch({ aspectRatio });
  }

  /** 完整流程：Director 理解场景 → Renderer 成像。 */
  async generate(): Promise<void> {
    if (this.busy) return;
    await this.run({ reuseShotPlan: false });
  }

  /** 重拍同一镜头：保留 ShotPlan，不调用 Director，只重新成像（可换 Renderer）。 */
  async rerenderSameShot(): Promise<void> {
    if (this.busy) return;
    const shotPlan = this.state.shotPlan;
    if (!shotPlan) return;
    await this.run({ reuseShotPlan: true, existingShotPlan: shotPlan });
  }

  /** 重新导演：重新调用 Director，当前 ShotPlan 作为 previousShotPlan 传入差异化。 */
  async redirectNewShot(): Promise<void> {
    if (this.busy) return;
    await this.run({ reuseShotPlan: false });
  }

  /** Renderer 失败后的重试：有 ShotPlan → 只重拍；无 ShotPlan → 完整重新生成。 */
  async retry(): Promise<void> {
    if (this.busy) return;
    if (this.state.shotPlan) await this.rerenderSameShot();
    else await this.generate();
  }

  /** 关闭 modal / 卸载时调用：中止请求并回到初始态（第一版不持久化临时 ShotPlan）。 */
  reset(): void {
    this.controller?.abort();
    this.controller = null;
    this.busy = false;
    this.state = { ...INITIAL_SCENE_CAMERA_SESSION_STATE };
    this.notify();
  }

  private patch(patch: Partial<SceneCameraSessionState>): void {
    this.state = { ...this.state, ...patch };
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private async run(options: { reuseShotPlan: boolean; existingShotPlan?: SceneCameraShotPlan }): Promise<void> {
    this.busy = true;
    this.controller?.abort();
    this.controller = new AbortController();
    const signal = this.controller.signal;

    try {
      let shotPlan = options.existingShotPlan;

      if (!options.reuseShotPlan) {
        this.patch({ phase: 'directing', error: undefined });
        const directorConfig = this.deps.getDirectorConfig();
        const previousShotPlan = this.state.shotPlan;
        shotPlan = await (this.deps.requestShotPlan ?? generateShotPlanOnly)({
          mode: this.state.mode,
          sceneContext: this.deps.getSceneContext(),
          character: this.deps.getCharacter(),
          directorConfig,
          previousShotPlan,
        });
        this.patch({
          shotPlan,
          previousShotPlan,
          directorMetadata: { provider: directorConfig.provider, model: directorConfig.model },
        });
      }

      this.patch({ phase: 'rendering', error: undefined });
      const rendererConfig = this.deps.getRendererConfig();
      const result = await (this.deps.renderExistingShotPlan ?? renderShotPlan)({
        shotPlan: shotPlan!,
        character: this.deps.getCharacter(),
        rendererConfig,
        aspectRatio: this.state.aspectRatio,
        signal,
      });
      this.patch({
        phase: 'done',
        shotPlan: result.shotPlan,
        imageUrl: result.imageUrl,
        rendererMetadata: result.rendererMetadata,
      });
      this.logDebug();
    } catch (error) {
      // 关闭 modal 触发的 abort 不算错误；state 已被 reset() 清理。
      if (signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      // Renderer 失败时 shotPlan 已在 state 中，保留给「重试 / 重拍同一镜头」。
      this.patch({ phase: 'error', error: message });
    } finally {
      this.busy = false;
      this.notify();
    }
  }

  /** 开发阶段调试输出：只打必要信息，不打 API Key、不打完整上下文与 finalPrompt。 */
  private logDebug(): void {
    if (!this.deps.debug) return;
    const s = this.state;
    console.debug('[SceneCamera] shot complete', {
      mode: s.mode,
      phase: s.phase,
      director: s.directorMetadata,
      renderer: s.rendererMetadata,
      aspectRatio: s.aspectRatio,
      cameraPosition: s.shotPlan?.cameraPosition,
      shotSize: s.shotPlan?.shotSize,
      composition: s.shotPlan?.composition,
    });
  }
}
