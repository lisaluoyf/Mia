import { DEFAULT_MODELS } from "../constants.js";

export type ModelConfigGroup = "user_default" | "internal";

export type ModelConfigKey =
  | "user_chat_default"
  | "user_vision_default"
  | "user_image_default"
  | "user_video_default"
  | "intent_router"
  | "private_compaction"
  | "group_compaction"
  | "guest_chat";

export interface ModelConfigDefinition {
  key: ModelConfigKey;
  group: ModelConfigGroup;
  scenario: string;
  description: string;
  defaultModel: string | null;
  capability: "chat" | "vision" | "image" | "video";
}

export interface ModelConfigEntry extends ModelConfigDefinition {
  model: string | null;
  updatedAt: string | null;
}

export type ModelConfigValues = Record<ModelConfigKey, string | null>;

export const MODEL_CONFIG_DEFINITIONS: readonly ModelConfigDefinition[] = [
  {
    key: "user_chat_default",
    group: "user_default",
    scenario: "普通聊天",
    description: "用户没有单独选择时的 Chat 默认模型",
    defaultModel: DEFAULT_MODELS.chat,
    capability: "chat",
  },
  {
    key: "user_vision_default",
    group: "user_default",
    scenario: "图片理解",
    description: "用户没有单独选择时的 Vision 默认模型；留空表示自动选择",
    defaultModel: null,
    capability: "vision",
  },
  {
    key: "user_image_default",
    group: "user_default",
    scenario: "图片生成与编辑",
    description: "用户没有单独选择时的 Image 默认模型",
    defaultModel: DEFAULT_MODELS.image,
    capability: "image",
  },
  {
    key: "user_video_default",
    group: "user_default",
    scenario: "视频生成",
    description: "用户没有单独选择时的 Video 默认模型",
    defaultModel: DEFAULT_MODELS.video,
    capability: "video",
  },
  {
    key: "intent_router",
    group: "internal",
    scenario: "意图识别与路由",
    description: "识别聊天、图片、贴纸、视频等请求的内部模型",
    defaultModel: "gpt-5.4",
    capability: "chat",
  },
  {
    key: "private_compaction",
    group: "internal",
    scenario: "私聊记忆整理",
    description: "每 10 轮整理用户长期记忆和私聊滚动摘要的内部模型",
    defaultModel: "gpt-5.4",
    capability: "chat",
  },
  {
    key: "group_compaction",
    group: "internal",
    scenario: "群聊上下文整理",
    description: "整理群聊或 Topic 滚动摘要与公共记忆的内部模型",
    defaultModel: "gpt-5.4",
    capability: "chat",
  },
  {
    key: "guest_chat",
    group: "internal",
    scenario: "访客聊天与无 Key 回退",
    description: "没有可用用户 Key 时使用的受限文本聊天模型",
    defaultModel: "gpt-5.4",
    capability: "chat",
  },
] as const;

export const MODEL_CONFIG_KEYS: readonly ModelConfigKey[] = MODEL_CONFIG_DEFINITIONS.map((item) => item.key);

export function modelConfigDefaults(overrides: Partial<ModelConfigValues> = {}): ModelConfigValues {
  return Object.fromEntries(MODEL_CONFIG_DEFINITIONS.map((definition) => [
    definition.key,
    overrides[definition.key] === undefined ? definition.defaultModel : overrides[definition.key],
  ])) as ModelConfigValues;
}
