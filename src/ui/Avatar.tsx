import { useState, type ReactNode } from "react";

/**
 * The one avatar used wherever a person is drawn (Wave 35, D299): their picture when the server gave
 * an `avatarUrl` (a same-origin /api/users/:id/avatar URL, never Google's), else the letters the app
 * always showed. A picture that fails to load falls back to the letters too.
 */

/** The first letter of a name, upper-cased ("?" for an empty name). */
export const avatarInitial = (name: string) => (Array.from(name.trim())[0] ?? "?").toLocaleUpperCase();

type ViewProps = {
  name: string;
  url?: string | null;
  className: string;
  /** What to show without a picture; the name's first letter by default. */
  fallback?: ReactNode;
  failed: boolean;
  onError: () => void;
};

/**
 * Only Nook's own avatar route is ever loaded (review L10): anything else (another origin, a data:
 * or javascript: URL, another path) shows the letters.
 */
export const isAvatarPath = (url: string | null | undefined): url is string => typeof url === "string" && /^\/api\/users\/[0-9a-f-]{36}\/avatar\?v=[0-9a-f-]{36}$/.test(url);

/** Pure: the picture, or the fallback when there is no usable URL or it failed. */
export function AvatarView({ name, url, className, fallback, failed, onError }: ViewProps) {
  const showImage = isAvatarPath(url) && !failed;
  return <span className={showImage ? `${className} avatar-has-image` : className} aria-hidden="true">
    {showImage ? <img src={url!} alt="" loading="lazy" decoding="async" draggable={false} referrerPolicy="no-referrer" onError={onError} /> : fallback ?? avatarInitial(name)}
  </span>;
}

export function Avatar(props: Omit<ViewProps, "failed" | "onError">) {
  // Remembers which URL failed, so a new URL (a changed picture) is tried again.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const url = props.url ?? null;
  return <AvatarView {...props} failed={url !== null && failedUrl === url} onError={() => setFailedUrl(url)} />;
}
