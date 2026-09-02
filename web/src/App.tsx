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
  Video,
  X,
} from "lucide-react";

import { ApiError, loadBootstrap, savePreferences } from "./api";
import type { Capability, BootstrapData, ModelOption, Preferences } from "./types";
import type { TranslationKey } from "./i18n";
import { enableClosingConfirmation, notifyHaptic } from "./telegram";

interface AppProps {
  t: (key: TranslationKey) => string;
}

const preferenceKeys: Record<Capability, keyof Preferences> = {
  chat: "chatModel",
  image: "imageModel",
  video: "videoModel",
};

const icons = {
  chat: MessageCircle,
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

function Avatar({ user }: { user: BootstrapData["user"] }) {
  if (user.photoUrl) return <img className="avatar" src={user.photoUrl} alt="" />;
  return <div className="avatar avatar-fallback" aria-hidden="true">{user.firstName.slice(0, 1).toUpperCase()}</div>;
}

interface ModelSheetProps {
  capability: Capability;
  models: ModelOption[];
  selected: string | null;
  t: AppProps["t"];
  onSelect: (model: string) => void;
  onClose: () => void;
}

function ModelSheet({ capability, models, selected, t, onSelect, onClose }: ModelSheetProps) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return models;
    return models.filter((model) => `${model.displayName} ${model.id} ${model.vendor}`.toLowerCase().includes(needle));
  }, [models, query]);

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
              className={`model-option${selected === model.id ? " selected" : ""}`}
              type="button"
              key={model.id}
              onClick={() => onSelect(model.id)}
            >
              <span className="model-copy">
                <span className="model-name">{model.displayName}</span>
                <span className="model-meta">{model.vendor || model.id}</span>
              </span>
              {model.recommended && <span className="recommended">{t("recommended")}</span>}
              <span className="selection-mark" aria-hidden="true">{selected === model.id && <Check size={16} />}</span>
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
  const [active, setActive] = useState<Capability | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
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

  useEffect(() => {
    if (!data || !settings) return;
    const dirty = JSON.stringify(settings) !== JSON.stringify(data.settings);
    if (dirty) enableClosingConfirmation();
  }, [data, settings]);

  const dirty = Boolean(data && settings && JSON.stringify(settings) !== JSON.stringify(data.settings));

  const save = async () => {
    if (!settings || !data || !dirty || saving) return;
    setSaving(true);
    try {
      const saved = await savePreferences(settings);
      setSettings(saved);
      setData({ ...data, settings: saved, unavailable: [] });
      setToast("saved");
      notifyHaptic("success");
      window.setTimeout(() => setToast(null), 2200);
    } catch {
      setToast("saveFailed");
      notifyHaptic("error");
    } finally {
      setSaving(false);
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

  return (
    <main className="app-shell">
      <header className="profile-header">
        <Avatar user={data.user} />
        <div className="profile-copy">
          <span className="product-name">Mia</span>
          <span className="user-name">{displayName(data.user)}</span>
        </div>
        <h1>{t("settings")}</h1>
      </header>

      <section className="settings-list" aria-label={t("settings")}>
        {(["chat", "image", "video"] as const).map((capability) => {
          const Icon = icons[capability];
          const key = preferenceKeys[capability];
          const selected = data.models.find((model) => model.id === settings[key] && model.capability === capability);
          const options = data.models.filter((model) => model.capability === capability);
          return (
            <button className="setting-row" type="button" key={capability} onClick={() => setActive(capability)} disabled={options.length === 0}>
              <span className={`capability-icon ${capability}`}><Icon size={20} aria-hidden="true" /></span>
              <span className="setting-copy">
                <span className="setting-label">{t(capability)}</span>
                <span className="setting-value">{selected?.displayName ?? t("noModels")}</span>
              </span>
              {data.unavailable.includes(capability) && <span className="unavailable">{t("unavailable")}</span>}
              <ChevronRight className="chevron" size={19} aria-hidden="true" />
            </button>
          );
        })}
      </section>

      <button className="save-button" type="button" disabled={!dirty || saving} onClick={() => void save()}>
        {saving ? <LoaderCircle className="spinner" size={18} /> : <Check size={18} />}
        {t(saving ? "saving" : "save")}
      </button>

      {toast && <div className={`toast${toast === "saveFailed" ? " error" : ""}`} role="status">{t(toast)}</div>}

      {active && (
        <ModelSheet
          capability={active}
          models={data.models.filter((model) => model.capability === active)}
          selected={settings[preferenceKeys[active]]}
          t={t}
          onClose={() => setActive(null)}
          onSelect={(model) => {
            setSettings({ ...settings, [preferenceKeys[active]]: model });
            setActive(null);
          }}
        />
      )}
    </main>
  );
}
