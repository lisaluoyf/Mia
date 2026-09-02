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
  videoCapabilities?: {
    modes: Array<"text_to_video" | "image_to_video">;
    durationSeconds: { min: number; max: number; default: number };
    resolutions: string[];
    defaultResolution: string;
    aspectRatios: string[];
    defaultAspectRatio: string;
    maxReferenceImages: number;
  } | undefined;
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
