import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { isTauri } from "./lib/tauri";
import { isMac } from "./lib/platform";
import "./index.css";
import { loadMachineSecrets } from "./store/app";
import { autoConnectLocal } from "./store/local";

// The macOS Tauri window is transparent with sidebar vibrancy behind the chrome; elsewhere it is opaque.
if (isTauri && isMac) document.documentElement.classList.add("vibrancy");

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 5_000 } } });

// Credentials come from the keychain before the first request, so no request goes out unauthenticated.
void loadMachineSecrets().finally(() => {
  void autoConnectLocal();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  );
});
