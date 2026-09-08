export type ActivationTemplateId = "introduction_v1" | "weather_invite_v1" | "companion_v1";
export type ActivationDeliveryStatus = "claimed" | "sent" | "failed" | "interacted" | "dismissed";

export interface ActivationCandidate {
  telegramUserId: number;
  chatId: number;
  languageCode: string | null;
  firstSeenAt: string;
}

export interface ActivationDelivery {
  telegramUserId: number;
  chatId: number;
  sequence: 1 | 2;
  templateId: ActivationTemplateId;
  status: ActivationDeliveryStatus;
  sentAt: string | null;
}

export interface WeatherLocation {
  name: string;
  country: string;
  latitude: number;
  longitude: number;
  timezone: string;
}

export interface WeatherForecast {
  location: WeatherLocation;
  today: { min: number; max: number; code: number; precipitationProbability: number | null };
  tomorrow: { min: number; max: number; code: number; precipitationProbability: number | null };
}

export interface WeatherSubscription {
  telegramUserId: number;
  chatId: number;
  location: WeatherLocation;
  deliveryHour: number;
  status: "active" | "paused" | "cancelled";
  nextDeliveryAt: string;
}
