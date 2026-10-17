// A tiny pushState router (no dependency): usePath() + navigate() + <Link>.
import { useEffect, useState } from 'react';

export function navigate(to) {
  window.history.pushState({}, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function usePath() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const on = () => setPath(window.location.pathname);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return path;
}

/** @param {{ to: string, children: any, className?: string }} props */
export function Link({ to, children, className }) {
  return (
    <a
      href={to}
      className={className}
      aria-current={window.location.pathname === to ? 'page' : undefined}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}
