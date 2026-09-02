import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Check,
  ChevronRight,
  Image,
  LoaderCircle,
  MessageCircle,
  RotateCcw,
  Search,
  ScanEye,
  Sparkles,
  Video,
  X,
} from "lucide-react";

import { ApiError, loadBootstrap, savePreferences } from "./api";
import type { PreferenceCapability, BootstrapData, ModelOption, Preferences } from "./types";
import type { TranslationKey } from "./i18n";
import { notifyHaptic } from "./telegram";

interface AppProps {
  t: (key: TranslationKey) => string;
}

const preferenceKeys: Record<PreferenceCapability, keyof Preferences> = {
  chat: "chatModel",
  vision: "visionModel",
  image: "imageModel",
  video: "videoModel",
};

const icons = {
  chat: MessageCircle,
  vision: ScanEye,
  image: Image,
  video: Video,
};

function errorKey(error: unknown): TranslationKey {
  if (error instanceof ApiError) {
    if (error.code.startsWith("telegram_auth_")) return "authFailed";
    if (error.code === "telegram_not_bound") return "notBound";
    if (error.code === "user_disabled") return "accountDisabled";
    if (error.code === "no_usable_api_key") return "noKey";
  }
  return "serviceUnavailable";
}

function displayName(user: BootstrapData["user"]): string {
  return [user.firstName, user.lastName].filter(Boolean).join(" ");
}

function sameModelId(left: string | null, right: string | null): boolean {
  return left !== null && right !== null && left.toLowerCase() === right.toLowerCase();
}

interface ModelSheetProps {
  capability: PreferenceCapability;
  models: ModelOption[];
  selected: string | null;
  saving: boolean;
  t: AppProps["t"];
  onSelect: (model: string) => void;
  onClose: () => void;
}

function ModelSheet({ capability, models, selected, saving, t, onSelect, onClose }: ModelSheetProps) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matching = needle
      ? models.filter((model) => `${model.displayName} ${model.id} ${model.vendor}`.toLowerCase().includes(needle))
      : models;
    return [...matching].sort((left, right) => {
      const selectedRank = Number(sameModelId(right.id, selected)) - Number(sameModelId(left.id, selected));
      if (selectedRank !== 0) return selectedRank;
      const leftRecommended = capability === "vision" ? left.visionRecommended : left.recommended;
      const rightRecommended = capability === "vision" ? right.visionRecommended : right.recommended;
      return Number(rightRecommended) - Number(leftRecommended);
    });
  }, [capability, models, query, selected]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div className="sheet-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
        <div className="sheet-handle" />
        <header className="sheet-header">
          <div>
            <span className="sheet-kicker">{t(capability)}</span>
            <h2 id="sheet-title">{t("selectModel")}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label={t("close")} title={t("close")}>
            <X size={20} />
          </button>
        </header>
        <div className="search-field">
          <Search size={18} aria-hidden="true" />
          <input aria-label={t("search")} autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("search")} />
          {query && (
            <button type="button" onClick={() => setQuery("")} aria-label={t("close")} title={t("close")}>
              <X size={16} />
            </button>
          )}
        </div>
        <div className="model-list">
          {filtered.length === 0 && <div className="empty-state">{t("noModels")}</div>}
          {filtered.map((model) => (
            <button
              className={`model-option${sameModelId(selected, model.id) ? " selected" : ""}`}
              type="button"
              key={model.id}
              onClick={() => onSelect(model.id)}
              disabled={saving}
            >
              <span className="model-copy">
                <span className="model-name">{model.displayName}</span>
                {model.vendor && model.vendor.toLowerCase() !== "custom" && (
                  <span className="model-meta">{model.vendor}</span>
                )}
              </span>
              {(capability === "vision" ? model.visionRecommended : model.recommended)
                && <span className="recommended">{t("recommended")}</span>}
              <span className="selection-mark" aria-hidden="true">
                {saving && !sameModelId(selected, model.id)
                  ? null
                  : sameModelId(selected, model.id) && <Check size={16} />}
              </span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

export function App({ t }: AppProps) {
  const [data, setData] = useState<BootstrapData | null>(null);
  const [settings, setSettings] = useState<Preferences | null>(null);
  const [active, setActive] = useState<PreferenceCapability | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<PreferenceCapability | null>(null);
  const [error, setError] = useState<TranslationKey | null>(null);
  const [toast, setToast] = useState<TranslationKey | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await loadBootstrap();
      setData(next);
      setSettings(next.settings);
    } catch (loadError) {
      setError(errorKey(loadError));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const saveSelection = async (capability: PreferenceCapability, model: string) => {
    if (!settings || !data || saving) return;
    const key = preferenceKeys[capability];
    if (sameModelId(settings[key], model)) {
      setActive(null);
      return;
    }

    const nextSettings = { ...settings, [key]: model };
    setSaving(capability);
    setToast(null);
    try {
      const saved = await savePreferences(nextSettings);
      setSettings(saved);
      setData({
        ...data,
        settings: saved,
        unavailable: data.unavailable.filter((item) => item !== capability),
      });
      setActive(null);
      setToast("saved");
      notifyHaptic("success");
      window.setTimeout(() => setToast(null), 2200);
    } catch {
      setToast("saveFailed");
      notifyHaptic("error");
    } finally {
      setSaving(null);
    }
  };

  if (loading) {
    return <main className="center-state"><LoaderCircle className="spinner" size={26} aria-hidden="true" /></main>;
  }

  if (error || !data || !settings) {
    return (
      <main className="center-state error-page">
        <AlertCircle size={30} aria-hidden="true" />
        <p>{t(error ?? "serviceUnavailable")}</p>
        <button className="secondary-button" type="button" onClick={() => void load()}>
          <RotateCcw size={17} />{t("retry")}
        </button>
      </main>
    );
  }

  const visibleCapabilities: PreferenceCapability[] = data.models.some(
    (model) => model.capability === "chat" && model.supportsVision,
  )
    ? ["chat", "vision", "image", "video"]
    : ["chat", "image", "video"];

  return (
    <main className="app-shell">
      <header className="brand-header">
        <div className="assistant-portrait">
          <img src="/mia/mia-assistant.jpg" alt="Mia" />
          <span className="presence-dot" aria-hidden="true" />
        </div>
        <div className="brand-copy">
          <span className="product-name">Mia <Sparkles size={17} aria-hidden="true" /></span>
          <span className="user-name">{displayName(data.user)}</span>
        </div>
      </header>

      <section className="settings-section" aria-labelledby="settings-title">
        <h1 id="settings-title">{t("settings")}</h1>
        <div className="settings-list">
          {visibleCapabilities.map((capability) => {
            const Icon = icons[capability];
            const key = preferenceKeys[capability];
            const options = data.models.filter((model) => capability === "vision"
              ? model.capability === "chat" && model.supportsVision
              : capability === "video"
                ? model.capability === "video" && model.videoCapabilities !== undefined
                : model.capability === capability);
            const selected = options.find((model) => sameModelId(model.id, settings[key]));
            return (
              <button className="setting-row" type="button" key={capability} onClick={() => setActive(capability)} disabled={options.length === 0 || saving !== null}>
                <span className={`capability-icon ${capability}`}><Icon size={20} aria-hidden="true" /></span>
                <span className="setting-label">{t(capability)}</span>
                <span className="setting-selection">
                  <span className="setting-value">{selected?.displayName ?? settings[key] ?? t("noModels")}</span>
                  {data.unavailable.includes(capability) && <span className="unavailable">{t("unavailable")}</span>}
                </span>
                {saving === capability
                  ? <LoaderCircle className="spinner row-spinner" size={18} aria-hidden="true" />
                  : <ChevronRight className="chevron" size={19} aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      </section>

      {toast && <div className={`toast${toast === "saveFailed" ? " error" : ""}`} role="status">{t(toast)}</div>}

      {active && (
        <ModelSheet
          capability={active}
          models={data.models.filter((model) => active === "vision"
            ? model.capability === "chat" && model.supportsVision
            : active === "video"
              ? model.capability === "video" && model.videoCapabilities !== undefined
              : model.capability === active)}
          selected={settings[preferenceKeys[active]]}
          saving={saving === active}
          t={t}
          onClose={() => setActive(null)}
          onSelect={(model) => void saveSelection(active, model)}
        />
      )}
    </main>
  );
}
