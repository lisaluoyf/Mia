export type Capability = "chat" | "image" | "video";
export type PreferenceCapability = Capability | "vision";

export interface ModelOption {
  id: string;
  displayName: string;
  vendor: string;
  capability: Capability;
  recommended: boolean;
  supportsVision: boolean;
  visionRecommended: boolean;
  videoCapabilities?: {
    modes: string[];
    durationSeconds: { min: number; max: number; default: number };
    resolutions: string[];
    defaultResolution: string;
    aspectRatios: string[];
    defaultAspectRatio: string;
    maxReferenceImages: number;
  };
}

export interface Preferences {
  chatModel: string | null;
  visionModel: string | null;
  imageModel: string | null;
  videoModel: string | null;
}

export interface TelegramUser {
  id: number;
  firstName: string;
  lastName: string | null;
  username: string | null;
  languageCode: string | null;
  photoUrl: string | null;
}

export interface BootstrapData {
  user: TelegramUser;
  apimasterUserId: number;
  models: ModelOption[];
  settings: Preferences;
  unavailable: PreferenceCapability[];
}
