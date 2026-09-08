import type { WeatherForecast, WeatherLocation } from "./types.js";

const geocodingSchema = {
  async parse(response: Response): Promise<Array<{ name: string; country: string; latitude: number; longitude: number; timezone: string }>> {
    const payload = await response.json() as { results?: Array<{ name?: string; country?: string; latitude?: number; longitude?: number; timezone?: string }> };
    return (payload.results ?? []).flatMap((item) => (
      typeof item.name === "string" && typeof item.country === "string" && typeof item.latitude === "number" &&
      typeof item.longitude === "number" && typeof item.timezone === "string"
        ? [{ name: item.name, country: item.country, latitude: item.latitude, longitude: item.longitude, timezone: item.timezone }]
        : []
    ));
  },
};

export class WeatherClient {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async findCity(query: string): Promise<WeatherLocation[]> {
    const response = await this.fetcher(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=5&language=en&format=json`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("Weather city lookup failed");
    return geocodingSchema.parse(response);
  }

  async forecast(location: WeatherLocation): Promise<WeatherForecast> {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", String(location.latitude));
    url.searchParams.set("longitude", String(location.longitude));
    url.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max");
    url.searchParams.set("timezone", location.timezone);
    const response = await this.fetcher(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("Weather forecast lookup failed");
    const payload = await response.json() as { daily?: { weather_code?: number[]; temperature_2m_max?: number[]; temperature_2m_min?: number[]; precipitation_probability_max?: number[] } };
    const daily = payload.daily;
    if (!daily?.weather_code || !daily.temperature_2m_max || !daily.temperature_2m_min || daily.weather_code.length < 2) {
      throw new Error("Weather forecast response invalid");
    }
    return {
      location,
      today: { min: daily.temperature_2m_min[0]!, max: daily.temperature_2m_max[0]!, code: daily.weather_code[0]!, precipitationProbability: daily.precipitation_probability_max?.[0] ?? null },
      tomorrow: { min: daily.temperature_2m_min[1]!, max: daily.temperature_2m_max[1]!, code: daily.weather_code[1]!, precipitationProbability: daily.precipitation_probability_max?.[1] ?? null },
    };
  }
}

export function weatherDescription(code: number, chinese: boolean): string {
  const labels = chinese
    ? new Map([[0, "晴"], [1, "大致晴朗"], [2, "多云"], [3, "阴"], [45, "有雾"], [51, "毛毛雨"], [61, "小雨"], [63, "中雨"], [65, "大雨"], [71, "小雪"], [80, "阵雨"], [95, "雷雨"]])
    : new Map([[0, "clear"], [1, "mostly clear"], [2, "partly cloudy"], [3, "overcast"], [45, "foggy"], [51, "drizzle"], [61, "light rain"], [63, "rain"], [65, "heavy rain"], [71, "snow"], [80, "showers"], [95, "thunderstorms"]]);
  return labels.get(code) ?? (chinese ? "天气有变化" : "mixed conditions");
}
