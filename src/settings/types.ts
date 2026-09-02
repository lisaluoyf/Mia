import { DEFAULT_MODELS } from "../constants.js";

export type ModelCapability = "chat" | "image" | "video";

export interface ModelOption {
  id: string;
  displayName: string;
  vendor: string;
  capability: ModelCapability;
  recommended: boolean;
}

export interface ModelPreferences {
  chatModel: string | null;
  imageModel: string | null;
  videoModel: string | null;
}

export const DEFAULT_PREFERENCES: ModelPreferences = {
  chatModel: DEFAULT_MODELS.chat,
  imageModel: DEFAULT_MODELS.image,
  videoModel: DEFAULT_MODELS.video,
};

export function preferenceKey(capability: ModelCapability): keyof ModelPreferences {
  switch (capability) {
    case "chat":
      return "chatModel";
    case "image":
      return "imageModel";
    case "video":
      return "videoModel";
  }
}
