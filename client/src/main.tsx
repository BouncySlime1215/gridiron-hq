import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';
import { ToastProvider } from './components/ui/DesignSystem';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* v7_startTransition deliberately keeps the outgoing page on screen while a
        navigation is pending, instead of showing the Suspense fallback -- which
        is exactly what turned a page that hangs into a page that looks frozen
        with no error and no loading state at all (found leaving Trade Lab,
        2026-09-07). Off until whatever hangs is found and fixed; a route that
        can't render now shows RouteSkeleton, not last week's page. */}
    <BrowserRouter future={{ v7_relativeSplatPath: true }}>
      <ToastProvider><App /></ToastProvider>
    </BrowserRouter>
  </React.StrictMode>
);
