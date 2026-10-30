import { useEffect } from 'react';

export function useFavicon() {
  useEffect(() => {
    const icon = document.querySelector<HTMLLinkElement>(
      'link[rel="icon"][type="image/svg+xml"]',
    );
    if (!icon) return;
    icon.href = '/favicon-admin.svg';
    return () => {
      icon.href = '/favicon-portal.svg';
    };
  }, []);
}
