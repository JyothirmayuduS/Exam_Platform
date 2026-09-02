import React, { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import * as Sentry from "@sentry/react";
import { getSupabase } from "../lib/supabase";

interface Props {
  children?: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    // Update state so the next render will show the fallback UI.
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error:', error, errorInfo);
    // Send to Sentry
    if (typeof Sentry !== 'undefined' && Sentry.captureException) {
      Sentry.captureException(error, { extra: { errorInfo } });
    }

    // Send to our backend logging for crash emails
    try {
      const db = getSupabase();
      if (db) {
        db.functions.invoke("report-error", {
          body: {
            kind: "Crash Report",
            message: error.message,
            errorInfo: errorInfo.componentStack,
            url: window.location.href,
          }
        });
      }
    } catch (e) {
      // Silently fail if logging fails
    }
  }

  public render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }
      
      // Default fallback UI
      return (
        <div className="flex min-h-screen flex-col items-center justify-center bg-paper px-6 py-12 text-center">
          <div className="border border-line-strong bg-paper p-8 shadow-xl max-w-md w-full">
            <h1 className="font-serif text-3xl font-semibold text-alert">Something went wrong</h1>
            <p className="mt-4 text-[13px] text-ink-soft">
              An unexpected error occurred in the application. We have been notified and are looking into it.
            </p>
            <div className="mt-6 flex flex-col gap-3">
              <button 
                onClick={() => window.location.reload()} 
                className="border border-forest bg-forest px-6 py-3 font-mono text-[11px] uppercase tracking-wider text-paper hover:bg-forest-light"
              >
                Reload Page
              </button>
              <button 
                onClick={() => window.location.href = "/"} 
                className="border border-line-strong px-6 py-3 font-mono text-[11px] uppercase tracking-wider text-ink hover:border-forest"
              >
                Go to Home
              </button>
            </div>
            {this.state.error && (
              <div className="mt-8 text-left">
                <p className="font-mono text-[10px] uppercase tracking-widest text-ink-soft mb-2">Error Details (for developers)</p>
                <div className="bg-ink text-paper p-3 overflow-x-auto text-[11px] font-mono">
                  {this.state.error.toString()}
                </div>
              </div>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
