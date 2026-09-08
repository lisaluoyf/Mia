import type { Api } from "grammy";
import type { Logger } from "pino";

import type { APIMasterClient } from "../clients/apimaster.js";
import { resolveBotLocale } from "../telegram/localization.js";
import { activationTemplate, dailyWeatherKeyboard, weatherSubscriptionKeyboard } from "./templates.js";
import type { ActivationStore } from "./store.js";
import type { ActivationCandidate, ActivationTemplateId, WeatherForecast, WeatherSubscription } from "./types.js";
import { WeatherClient, weatherDescription } from "./weather.js";

const FIRST_TOUCH_DELAY_MS = 15 * 60 * 1_000;
const MAX_CANDIDATE_BATCH = 200;

export interface ActivationServiceOptions {
  store: ActivationStore;
  client: Pick<APIMasterClient, "resolveActivationEligibility">;
  api: Api;
  logger: Logger;
  enabled: boolean;
  botUsername: string;
  miniAppUrl: string;
  dailyLimit: number;
  intervalMs: number;
  previewTelegramUserIds: readonly number[];
  weather?: WeatherClient;
}

function templateHash(userId: number, salt: string): number {
  let hash = 2166136261;
  for (const character of `${userId}:${salt}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function firstTemplate(userId: number): ActivationTemplateId {
  return (["introduction_v1", "weather_invite_v1", "companion_v1"] as const)[templateHash(userId, "activation-v1") % 3]!;
}

function secondTemplate(userId: number, previous: ActivationTemplateId): ActivationTemplateId {
  const options = (["introduction_v1", "weather_invite_v1", "companion_v1"] as const).filter((item) => item !== previous);
  return options[templateHash(userId, "activation-v1-second") % options.length]!;
}

function shanghaiHour(now: Date): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", hour: "2-digit", hourCycle: "h23" }).format(now));
}

function templateAvailable(template: ActivationTemplateId, now: Date): boolean {
  const hour = shanghaiHour(now);
  if (template === "weather_invite_v1") return hour >= 7 && hour < 11;
  if (template === "companion_v1") return hour >= 19 && hour < 22;
  return hour >= 10 && hour < 18;
}

function weatherText(forecast: WeatherForecast, language?: string | null, tomorrowOnly = false): string {
  const locale = resolveBotLocale(language);
  const chinese = locale === "zh-CN" || locale === "zh-TW";
  const target = tomorrowOnly ? forecast.tomorrow : forecast.today;
  const day = tomorrowOnly ? (chinese ? "明天" : "Tomorrow") : (chinese ? "今天" : "Today");
  const rain = target.precipitationProbability === null ? "" : chinese
    ? `，降水概率 ${target.precipitationProbability}%`
    : `, ${target.precipitationProbability}% chance of precipitation`;
  return chinese
    ? `${forecast.location.name}${day}${weatherDescription(target.code, true)}，${Math.round(target.min)}-${Math.round(target.max)}°C${rain}。`
    : `${forecast.location.name}: ${day} will be ${weatherDescription(target.code, false)}, ${Math.round(target.min)}-${Math.round(target.max)}°C${rain}.`;
}

function nextDeliveryAt(subscription: Pick<WeatherSubscription, "location" | "deliveryHour">, now = new Date()): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: subscription.location.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(now).reduce<Record<string, string>>((result, item) => {
    if (item.type !== "literal") result[item.type] = item.value;
    return result;
  }, {});
  const year = Number(parts.year); const month = Number(parts.month); const day = Number(parts.day);
  const currentHour = Number(parts.hour);
  const tomorrow = currentHour >= subscription.deliveryHour;
  const target = new Date(Date.UTC(year, month - 1, day + (tomorrow ? 1 : 0), subscription.deliveryHour));
  const zoned = new Intl.DateTimeFormat("en-CA", {
    timeZone: subscription.location.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(target).reduce<Record<string, string>>((result, item) => {
    if (item.type !== "literal") result[item.type] = item.value;
    return result;
  }, {});
  const shown = Date.UTC(Number(zoned.year), Number(zoned.month) - 1, Number(zoned.day), Number(zoned.hour), Number(zoned.minute));
  return new Date(target.getTime() - (shown - target.getTime()));
}

export class ActivationService {
  private readonly weather: WeatherClient;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly options: ActivationServiceOptions) {
    this.weather = options.weather ?? new WeatherClient();
  }

  start(): void {
    if (!this.options.enabled || this.timer) return;
    this.timer = setInterval(() => void this.run(), this.options.intervalMs);
    this.timer.unref();
    void this.run();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async run(now = new Date()): Promise<void> {
    if (!this.options.enabled || this.running) return;
    this.running = true;
    try {
      await this.runActivation(now);
      await this.runWeatherSubscriptions(now);
    } catch (error) {
      this.options.logger.error({ err: error }, "Mia activation worker failed");
    } finally {
      this.running = false;
    }
  }

  private async runActivation(now: Date): Promise<void> {
    const first = this.options.store.listFirstCandidates(MAX_CANDIDATE_BATCH);
    const eligible = await this.activationEligible(first, now);
    let sent = 0;
    for (const candidate of eligible) {
      if (sent >= this.options.dailyLimit) break;
      const template = firstTemplate(candidate.telegramUserId);
      if (!templateAvailable(template, now) || !this.options.store.claimDelivery(candidate, 1, template, now)) continue;
      if (await this.sendActivation(candidate, 1, template)) sent += 1;
    }
    for (const candidate of this.options.store.listSecondCandidates(now, Math.max(0, this.options.dailyLimit - sent))) {
      if (sent >= this.options.dailyLimit) break;
      const previous = this.options.store.firstTemplate(candidate.telegramUserId);
      if (!previous) continue;
      const template = secondTemplate(candidate.telegramUserId, previous);
      if (!templateAvailable(template, now) || !this.options.store.claimDelivery(candidate, 2, template, now)) continue;
      if (await this.sendActivation(candidate, 2, template)) sent += 1;
    }
  }

  private async activationEligible(candidates: ActivationCandidate[], now: Date): Promise<ActivationCandidate[]> {
    if (candidates.length === 0) return [];
    const records = await this.options.client.resolveActivationEligibility(candidates.map((candidate) => candidate.telegramUserId));
    const boundAt = new Map(records.map((record) => [record.telegramUserId, record.boundAt.getTime()]));
    return candidates.filter((candidate) => {
      const time = boundAt.get(candidate.telegramUserId);
      return time !== undefined && now.getTime() - time >= FIRST_TOUCH_DELAY_MS;
    });
  }

  private async sendActivation(candidate: ActivationCandidate, sequence: 1 | 2, template: ActivationTemplateId): Promise<boolean> {
    try {
      await this.sendTemplate(candidate.chatId, template, candidate.languageCode);
      this.options.store.markSent(candidate.telegramUserId, sequence);
      return true;
    } catch (error) {
      this.options.store.markFailed(candidate.telegramUserId, sequence, error instanceof Error ? error.message : "send_failed");
      this.options.logger.warn({ err: error, telegramUserId: candidate.telegramUserId, template }, "Mia activation delivery failed");
      return false;
    }
  }

  markInteraction(telegramUserId: number): void { this.options.store.markInteraction(telegramUserId); }
  dismiss(telegramUserId: number, permanent: boolean): void { this.options.store.dismiss(telegramUserId, permanent); }
  beginWeatherIntent(telegramUserId: number, chatId: number): void { this.options.store.beginWeatherIntent(telegramUserId, chatId); }
  consumeWeatherIntent(telegramUserId: number, chatId: number): boolean { return this.options.store.consumeWeatherIntent(telegramUserId, chatId); }

  async requestWeather(telegramUserId: number, chatId: number, city: string): Promise<{ forecast: WeatherForecast } | { choices: string[] } | null> {
    const matches = await this.weather.findCity(city.trim());
    if (matches.length === 0) return null;
    const sameName = matches.filter((item) => item.name.toLocaleLowerCase() === matches[0]!.name.toLocaleLowerCase());
    if (sameName.length > 1 && !city.includes(",")) return { choices: sameName.map((item) => `${item.name}, ${item.country}`) };
    const location = matches[0]!;
    this.options.store.saveWeatherRequest(telegramUserId, chatId, location);
    return { forecast: await this.weather.forecast(location) };
  }

  subscribeWeather(telegramUserId: number, hour: number): WeatherSubscription | null {
    const pending = this.options.store.getWeatherRequest(telegramUserId);
    if (!pending) return null;
    return this.options.store.createWeatherSubscription(telegramUserId, hour, nextDeliveryAt({ location: pending.location, deliveryHour: hour }));
  }

  async weatherTextForRequest(telegramUserId: number, language?: string | null, tomorrowOnly = false): Promise<string | null> {
    const request = this.options.store.getWeatherRequest(telegramUserId);
    const subscription = request === null ? this.options.store.getWeatherSubscription(telegramUserId) : null;
    const location = request?.location ?? subscription?.location;
    if (!location) return null;
    return weatherText(await this.weather.forecast(location), language, tomorrowOnly);
  }

  pauseWeather(telegramUserId: number, cancelled: boolean): void { this.options.store.setWeatherSubscriptionStatus(telegramUserId, cancelled ? "cancelled" : "paused"); }

  async sendPreviews(): Promise<void> {
    for (const userId of this.options.previewTelegramUserIds) {
      for (const template of ["introduction_v1", "weather_invite_v1", "companion_v1"] as const) {
        await this.sendTemplate(userId, template, "zh-CN");
      }
      await this.options.api.sendMessage(userId, "早上好，上海今天多云，24-31°C，傍晚可能有阵雨。", {
        reply_markup: dailyWeatherKeyboard("zh-CN"),
      });
    }
  }

  private async sendTemplate(chatId: number, template: ActivationTemplateId, language?: string | null): Promise<void> {
    const content = activationTemplate(template, language, {
      botUsername: this.options.botUsername,
      miniAppUrl: this.options.miniAppUrl,
    });
    if (template === "introduction_v1") {
      const image = new URL("mia-introduction.png", this.options.miniAppUrl).toString();
      await this.options.api.sendPhoto(chatId, image, { caption: content.text, reply_markup: content.keyboard });
      return;
    }
    await this.options.api.sendMessage(chatId, content.text, { reply_markup: content.keyboard });
  }

  private async runWeatherSubscriptions(now: Date): Promise<void> {
    const due = this.options.store.listDueWeatherSubscriptions(now, this.options.dailyLimit);
    const cache = new Map<string, WeatherForecast>();
    for (const subscription of due) {
      const key = `${subscription.location.latitude},${subscription.location.longitude},${subscription.location.timezone}`;
      try {
        let forecast = cache.get(key);
        if (!forecast) {
          forecast = await this.weather.forecast(subscription.location);
          cache.set(key, forecast);
        }
        await this.options.api.sendMessage(subscription.chatId, weatherText(forecast, null), { reply_markup: dailyWeatherKeyboard() });
        this.options.store.completeWeatherDelivery(subscription.telegramUserId, nextDeliveryAt(subscription, now));
      } catch (error) {
        this.options.logger.warn({ err: error, telegramUserId: subscription.telegramUserId }, "Mia weather delivery failed");
      }
    }
  }

  weatherSubscriptionKeyboard(language?: string | null) { return weatherSubscriptionKeyboard(language); }
}
