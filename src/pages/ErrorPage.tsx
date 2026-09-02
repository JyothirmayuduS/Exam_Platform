import { useLocation, useNavigate, useRouteError, isRouteErrorResponse } from "react-router-dom";
import { ErrorBoundary } from "../components/ErrorBoundary";

export default function ErrorPage() {
  const error = useRouteError();
  const navigate = useNavigate();
  const location = useLocation();
  
  console.error("Route error caught:", error);

  let title = "Something went wrong";
  let message = "An unexpected error occurred.";
  let code = "500";

  if (isRouteErrorResponse(error)) {
    code = String(error.status);
    if (error.status === 404) {
      title = "Page Not Found";
      message = `The path ${location.pathname} does not exist.`;
    } else if (error.status === 503) {
      title = "Service Unavailable";
      message = "Our servers are currently undergoing maintenance. Please try again later.";
    } else {
      title = error.statusText || title;
      message = error.data || message;
    }
  } else if (error instanceof Error) {
    message = error.message;
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-paper px-6 py-12 text-center">
      <div className="border border-line-strong bg-paper p-8 shadow-xl max-w-md w-full">
        <p className="font-mono text-[14px] uppercase tracking-widest text-alert">{code} Error</p>
        <h1 className="mt-2 font-serif text-3xl font-semibold text-ink">{title}</h1>
        <p className="mt-4 text-[13px] text-ink-soft">
          {message}
        </p>
        <div className="mt-8 flex flex-col gap-3">
          <button 
            onClick={() => navigate(-1)} 
            className="border border-line-strong px-6 py-3 font-mono text-[11px] uppercase tracking-wider text-ink hover:border-forest"
          >
            ← Go Back
          </button>
          <button 
            onClick={() => navigate("/")} 
            className="border border-forest bg-forest px-6 py-3 font-mono text-[11px] uppercase tracking-wider text-paper hover:bg-forest-light"
          >
            Go to Home
          </button>
        </div>
      </div>
    </div>
  );
}
