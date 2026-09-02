import { DEFAULT_MODELS } from "../constants.js";

export type ModelCapability = "chat" | "image" | "video";
export type ModelPreferenceCapability = ModelCapability | "vision";

export interface ModelOption {
  id: string;
  displayName: string;
  vendor: string;
  capability: ModelCapability;
  recommended: boolean;
  supportsVision: boolean;
  visionRecommended: boolean;
}

export interface ModelPreferences {
  chatModel: string | null;
  visionModel: string | null;
  imageModel: string | null;
  videoModel: string | null;
}

export const DEFAULT_PREFERENCES: ModelPreferences = {
  chatModel: DEFAULT_MODELS.chat,
  visionModel: null,
  imageModel: DEFAULT_MODELS.image,
  videoModel: DEFAULT_MODELS.video,
};

export function preferenceKey(capability: ModelPreferenceCapability): keyof ModelPreferences {
  switch (capability) {
    case "chat":
      return "chatModel";
    case "vision":
      return "visionModel";
    case "image":
      return "imageModel";
    case "video":
      return "videoModel";
  }
}
