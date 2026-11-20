import { ChevronDown, Expand, Gauge, Hand, Moon, RefreshCw, Shrink, Volume2, VolumeX } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";

const SLEEP_AFTER_MS = 2 * 60_000;
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { screenUrl, sessionDesktops, supports } from "@/api/client";
import type { Health } from "@/api/types";
import { Spinner } from "@/components/StatusIcon";
import { isTauri } from "@/lib/tauri";
import { Button } from "@/components/ui/button";
import { isMac } from "@/lib/platform";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/tooltip";
import { useAuthedImage } from "@/hooks/useAuthedImage";
import { useChat } from "@/hooks/useChat";
import { NO_DESKTOP } from "@/lib/desktops";
import { latestClick, screenGeometry } from "@/lib/timeline";
import { QUALITIES, rateText, readoutText, signalBars, stream, useStream, type Quality } from "@/lib/stream";
import { cn } from "@/lib/utils";
import { devicePixels } from "@/lib/view";
import { baseUrl, useApp, type Machine } from "@/store/app";

/** Content box of an object-fit: contain child inside a container. */
function fitRect(box: DOMRect, ratio: number) {
  if (!ratio || !box.width || !box.height) return null;
  const w = Math.min(box.width, box.height * ratio);
  const h = w / ratio;
  return { left: (box.width - w) / 2, top: (box.height - h) / 2, width: w, height: h };
}

function ClickMarker({ stage, ratio }: { stage: HTMLElement | null; ratio: number }) {
  const chatState = useChat();
  const click = latestClick(chatState.activities);
  const geo = screenGeometry(chatState.activities);
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    if (!click) return;
    setShown(click.id);
    const t = setTimeout(() => setShown(null), 2600);
    return () => clearTimeout(t);
  }, [click?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!click || !geo || shown !== click.id || !stage) return null;
  const rect = fitRect(stage.getBoundingClientRect(), ratio || geo.pointWidth / geo.pointHeight);
  if (!rect) return null;
  const left = rect.left + (click.x / geo.pointWidth) * rect.width;
  const top = rect.top + (click.y / geo.pointHeight) * rect.height;
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden>
      <span key={click.id} className="absolute size-9 animate-ping-once rounded-full border-2 border-accent" style={{ left, top }} />
      <span className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent shadow-[0_0_0_3px_var(--accent-soft)]" style={{ left, top }} />
    </div>
  );
}

/** The screen's last picture; with onError, the reason it is missing goes to the caller instead. */
function Snapshot({ base, sessionId, width, onRatio, onError }: {
  base: string; sessionId?: string; width: number; onRatio: (r: number) => void; onError?: (reason: string) => void;
}) {
  const [tick, setTick] = useState(0);
  // As wide as the panel shows it; an unchanged screen costs a 304, not a download.
  const image = useAuthedImage(base, width ? screenUrl(base, devicePixels(width, window.devicePixelRatio), 65, sessionId) : null, tick);
  const [undecodable, setUndecodable] = useState<string | undefined>(undefined);
  // mobd's reason (locked, asleep, no Screen Recording) until a later check succeeds, 304 included.
  const error = image.error || (undecodable === image.src ? "the snapshot could not be shown" : "");
  const state = error ? "error" : image.src ? "ok" : "loading";
  const at = image.at ? new Date(image.at).toLocaleTimeString() : "";
  const asleep = image.desktopState === "asleep";
  const reason = state === "error" ? (image.code === "no_desktop" ? NO_DESKTOP : error.replace(/^screen unavailable: /, "")) : "";
  useEffect(() => onError?.(reason), [reason]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // While the screen sleeps the picture stays fairly current; paused while the window is hidden.
    const t = setInterval(() => document.visibilityState === "visible" && setTick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);
  return (
    <>
      <img
        src={image.src}
        alt="Screen snapshot"
        className={cn("absolute inset-0 size-full object-contain", state === "error" && "invisible")}
        onLoad={(e) => {
          setUndecodable(undefined);
          onRatio(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight);
        }}
        onError={() => setUndecodable(image.src)}
      />
      {state === "error" && !onError && (
        <p className="absolute inset-0 flex items-center justify-center p-4 text-center text-xs text-muted-foreground">
          {image.code === "no_desktop" ? NO_DESKTOP : `Snapshot unavailable: ${error.replace(/^screen unavailable: /, "")}`}
        </p>
      )}
      {state === "ok" && !onError && (
        <>
          {asleep && (
            <span className="absolute left-2 top-2 rounded bg-black/65 px-2 py-0.5 text-[10px] font-medium text-white/90 backdrop-blur">
              Asleep
            </span>
          )}
          <button
            type="button"
            onClick={() => setTick((n) => n + 1)}
            className="absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-white/90 hover:bg-black/70"
          >
            <RefreshCw className="size-2.5" /> Snapshot · {at}
          </button>
        </>
      )}
    </>
  );
}

/** Quality for this machine's live view; picking one reconnects an open view (mobd fixes it per session). */
function QualityMenu({ machine, dark }: { machine: Machine; dark: boolean }) {
  const setLiveQuality = useApp((s) => s.setLiveQuality);
  const value = machine.liveQuality ?? "auto";
  const label = QUALITIES.find((q) => q.value === value)?.label;
  return (
    <DropdownMenu>
      <Tooltip content={`Live view quality: ${label}`}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" aria-label={`Live view quality: ${label}`}
            className={cn("h-7 gap-1 px-1.5 text-[11.5px]", dark && "text-white/80 hover:bg-white/10 hover:text-white")}>
            <Gauge className="size-3.5" />
            {/* The panel header is narrow: the icon alone there, the name in full screen. */}
            {dark && <>{label} <ChevronDown className="size-3 opacity-60" /></>}
          </Button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-64" onCloseAutoFocus={(e) => e.preventDefault()}>
        <DropdownMenuLabel>Live view quality</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={value} onValueChange={(q) => setLiveQuality(machine.id, q as Quality)}>
          {QUALITIES.map((q) => (
            <DropdownMenuRadioItem key={q.value} value={q.value} className="items-start">
              <span className="grid gap-0.5">
                <span className="font-medium">{q.label}</span>
                <span className="text-[11px] leading-snug text-muted-foreground">{q.hint}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Connection quality as three bars, coloured when it degrades. */
/** The desktop's sound: off until clicked (mobd with streamAudio, docs/desktop-audio.md). */
function SoundButton({ dark }: { dark: boolean }) {
  const s = useStream();
  if (s.sound === "none") return null;
  const on = s.sound === "on" || s.sound === "starting";
  const blocked = s.sound === "unavailable" || s.sound === "error";
  const tip = blocked ? s.soundDetail
    : s.status !== "connected" ? "Sound plays once the live view is connected"
    : on ? "Turn sound off" : s.soundDetail || "Turn sound on";
  return (
    <Tooltip content={tip}>
      <span>
        <Button variant="ghost" size="icon-sm" aria-label={on ? "Turn sound off" : "Turn sound on"} aria-pressed={on}
          disabled={blocked || s.status !== "connected"}
          className={cn(dark && "hover:bg-white/10", on ? "text-success" : dark ? "text-white/80" : undefined)}
          onClick={() => stream.setSound(!on)}>
          {s.sound === "starting" ? <Spinner /> : on ? <Volume2 /> : <VolumeX />}
        </Button>
      </span>
    </Tooltip>
  );
}

function SignalBars({ bars }: { bars: 1 | 2 | 3 }) {
  const on = bars === 3 ? "bg-success" : bars === 2 ? "bg-warning" : "bg-danger";
  return (
    <span className="flex h-3 items-end gap-px" aria-hidden>
      {[1, 2, 3].map((i) => (
        <span key={i} className={cn("w-[3px] rounded-[1px]", i <= bars ? on : "bg-white/20")} style={{ height: `${i * 4}px` }} />
      ))}
    </span>
  );
}

/** Another computer's screen (docs/desktop-redesign D6): asleep until clicked, then live; Take control. */
export function ScreenView({ machine, health }: { machine: Machine; health?: Health }) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  // The live desktop is mobd's stream (WebRTC, or the WebSocket fallback); mobd without the stream
  // feature gets "Update mobd" from the connect.
  const streamState = useStream();
  const state = streamState;
  const { fullscreen, set } = useApp();
  const chatState = useChat();
  const [ratio, setRatio] = useState(0);
  const [, relayout] = useState(0);
  const connected = state.status === "connected";
  const running = chatState.currentTask?.status === "running";
  const perSession = sessionDesktops(health);
  const sessionId = perSession ? chatState.sessionId ?? undefined : undefined;
  const hasDesktop = !perSession || !!sessionId;
  const canSnapshot = supports(health, "screen") && !connected && hasDesktop;
  const live = stream;

  // The screen sleeps when the computer or the open conversation changes (docs/desktop-redesign D6).
  useEffect(() => () => stream.disconnect(), [machine.id]);
  const openId = chatState.sessionId;
  const prevOpenId = useRef(openId);
  useEffect(() => {
    if (prevOpenId.current === openId) return;
    prevOpenId.current = openId;
    if (stream.state.status === "connected" || stream.state.status === "connecting") stream.disconnect();
  }, [openId]);
  // ...and after two minutes without anything happening: no agent step, no pointer over it, no control.
  const steps = chatState.activities.length;
  const [touched, setTouched] = useState(0);
  const [snapError, setSnapError] = useState("");
  useEffect(() => {
    if (state.status !== "connected" || state.control) return;
    const t = setTimeout(() => stream.disconnect(), SLEEP_AFTER_MS);
    return () => clearTimeout(t);
  }, [state.status, state.control, steps, touched, running]);
  useEffect(() => {
    if (state.width && state.height) setRatio(state.width / state.height);
  }, [state.width, state.height]);
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => relayout((n) => n + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const opened = useRef({ width: 0, height: 0 });
  const connect = (control = false) => {
    const box = stage.current?.getBoundingClientRect();
    if (!video.current || !canvas.current || !box) return;
    opened.current = { width: devicePixels(box.width, window.devicePixelRatio), height: devicePixels(box.height, window.devicePixelRatio) };
    void stream.connect({ video: video.current, canvas: canvas.current }, {
      base: baseUrl(machine), health,
      maxWidth: opened.current.width, maxHeight: opened.current.height,
      quality: machine.liveQuality ?? "auto", preferWebSocket: machine.liveWebSocket, control,
      sessionId,
    });
  };
  // The stream is sized to the view. mobd with streamResize refits the running session; older builds
  // are reconnected at the new size.
  const canResize = supports(health, "streamResize");
  const reconnect = useRef(connect);
  reconnect.current = connect;
  // mobd fixes the profile per session: a new quality reconnects, keeping control if it was on.
  const quality = machine.liveQuality ?? "auto";
  const lastQuality = useRef(quality);
  useEffect(() => {
    if (lastQuality.current === quality) return;
    lastQuality.current = quality;
    if (stream.state.status === "connected") reconnect.current(stream.state.control);
  }, [quality]);
  const wasFullscreen = useRef(fullscreen);
  useEffect(() => {
    if (wasFullscreen.current === fullscreen) return;
    wasFullscreen.current = fullscreen;
    const control = stream.state.control;
    if (stream.state.status !== "connected") return;
    // With resize, the stage's resize observer refits the stream; only control is left to take.
    const raf = requestAnimationFrame(() => (canResize ? control && stream.setControl(true) : reconnect.current(control)));
    return () => cancelAnimationFrame(raf);
  }, [fullscreen, canResize]);
  // Once the view has stopped changing size: refit the running stream, or reconnect for older mobd.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => {
        if (stream.state.status !== "connected") return;
        const width = devicePixels(el.clientWidth, window.devicePixelRatio);
        const height = devicePixels(el.clientHeight, window.devicePixelRatio);
        if (width === opened.current.width && height === opened.current.height) return;
        if (canResize && stream.resize(width, height)) opened.current = { width, height };
        else reconnect.current(stream.state.control);
      }, canResize ? 150 : 600);
    });
    ro.observe(el);
    return () => {
      clearTimeout(t);
      ro.disconnect();
    };
  }, [canResize]);
  // Remember whether this machine needed the WebSocket, so the next connect races it at once.
  const setLiveWebSocket = useApp((s) => s.setLiveWebSocket);
  useEffect(() => {
    if (streamState.status !== "connected" || !streamState.transport) return;
    const ws = streamState.transport === "WebSocket";
    if (ws !== !!machine.liveWebSocket) setLiveWebSocket(machine.id, ws);
  }, [streamState.status, streamState.transport]); // eslint-disable-line react-hooks/exhaustive-deps
  // Take control (also ⇧⌘C): wakes the screen if needed; Esc or Release gives it back.
  const takeControl = () => {
    if (!connected) reconnect.current(true);
    else live.setControl(true);
  };
  const takeControlRef = useRef(takeControl);
  takeControlRef.current = takeControl;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ⇧⌘C on macOS, Ctrl+Shift+C elsewhere.
      const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (mod && e.shiftKey && !e.altKey && e.code === "KeyC") {
        e.preventDefault();
        takeControlRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // Connect requests from the command palette, which has no access to the view.
  const { liveConnect } = useApp();
  useEffect(() => {
    if (!liveConnect) return;
    useApp.getState().set({ liveConnect: 0 });
    reconnect.current();
  }, [liveConnect]);
  const control = connected && state.control;
  const bars = signalBars(streamState.loss, streamState.readout?.rttMs);
  const waking = state.status === "connecting";
  const rate = connected && state.width > 0 ? (streamState.readout ? rateText(streamState.readout) : `${state.width}×${state.height}`) : "";
  const tool = fullscreen ? "text-white/85 hover:bg-white/10 hover:text-white" : "text-white/90 hover:bg-white/15 hover:text-white";

  const tools = (
    <>
      {!control && (
        <Button size="sm" variant="ghost" onClick={takeControl} className={cn("h-7 gap-1.5 px-2 text-xs", tool)}>
          <Hand className="size-3.5" /> Take control
        </Button>
      )}
      <span className="flex-1" />
      <SoundButton dark />
      {fullscreen && <QualityMenu machine={machine} dark />}
      <IconButton label={fullscreen ? "Back to the panel" : "Open in the window"} className={tool} onClick={() => set({ fullscreen: !fullscreen })}>
        {fullscreen ? <Shrink /> : <Expand />}
      </IconButton>
      <IconButton label="Put the screen to sleep" className={tool} onClick={() => live.disconnect()}><Moon /></IconButton>
    </>
  );

  const screen = (
    <div
      ref={stage}
      onPointerMove={() => connected && setTouched(Date.now())}
      onDoubleClick={(e) => {
        // While controlling, double-clicks belong to the other computer.
        if (control || (e.target as HTMLElement).closest("button")) return;
        if (connected) set({ fullscreen: !fullscreen });
      }}
      className={cn(
        "group/screen relative overflow-hidden bg-[#0d0e12]",
        fullscreen ? "min-h-0 flex-1" : "aspect-[16/10] rounded-[10px] border",
        control && "ring-2 ring-inset ring-accent",
      )}
    >
      <video ref={video} muted playsInline autoPlay tabIndex={-1} aria-label={`${machine.name} screen, live`}
        className={cn("absolute inset-0 size-full object-contain outline-none", (!connected || streamState.element !== "video") && "invisible", control && "touch-none")} />
      {/* The WebSocket fallback draws decoded frames here instead of the video. */}
      <canvas ref={canvas} tabIndex={-1} aria-label={`${machine.name} screen, live`}
        className={cn("absolute inset-0 size-full object-contain outline-none", (!connected || streamState.element !== "canvas") && "invisible", control && "touch-none")} />
      {!connected && canSnapshot && (
        <div className="absolute inset-0 opacity-45">
          <Snapshot base={chatState.baseUrl} sessionId={sessionId} width={stage.current?.clientWidth ?? 0} onRatio={setRatio} onError={setSnapError} />
        </div>
      )}
      {!connected && (
        // Asleep: the last picture, dimmed; a click wakes it.
        <button type="button" disabled={waking || !hasDesktop} onClick={() => connect()}
          className="absolute inset-0 flex flex-col items-center justify-center gap-1 p-4 text-center text-white disabled:cursor-default">
          {waking ? <Spinner className="border-white border-t-transparent" /> : <Moon className="size-4 text-white/80" />}
          <span className="text-[13px] font-semibold">{waking ? "Waking…" : hasDesktop ? "Asleep" : "No screen yet"}</span>
          <span className="max-w-[90%] text-[11px] text-white/65">
            {!hasDesktop ? NO_DESKTOP : state.status === "error" ? (state.detail === NO_DESKTOP ? NO_DESKTOP : state.detail) : waking ? "" : snapError ? `Click to wake · ${snapError}` : "Click to wake"}
          </span>
        </button>
      )}
      <ClickMarker stage={stage.current} ratio={ratio} />
      {connected && !control && !fullscreen && (
        <span className="pointer-events-none absolute left-2 top-2 flex items-center gap-1.5 rounded-md bg-black/60 px-1.5 py-0.5 text-[10.5px] font-medium text-white backdrop-blur">
          <span className="size-1.5 rounded-full bg-success" /> Live{rate && ` · ${rate}`}
        </span>
      )}
      {control && (
        <div className="absolute inset-x-0 top-0 flex items-center gap-1.5 bg-accent py-1 pl-2.5 pr-1.5 text-[11.5px] font-medium text-accent-foreground">
          <Hand className="size-3.5" /> You're in control
          <button type="button" onClick={() => live.setControl(false)}
            className="ml-auto flex items-center gap-1.5 rounded-md bg-accent-foreground/15 px-2 py-0.5 text-[11px] hover:bg-accent-foreground/25">
            Release <span className="text-[10px] opacity-75">Esc</span>
          </button>
        </div>
      )}
      {connected && !fullscreen && (
        <div className="absolute inset-x-0 bottom-0 flex items-center gap-0.5 bg-gradient-to-t from-black/70 to-transparent px-1.5 pb-1 pt-4 opacity-0 transition-opacity focus-within:opacity-100 group-hover/screen:opacity-100">
          {tools}
        </div>
      )}
    </div>
  );

  // Expanded, the screen fills the app window like a remote desktop app: its toolbar takes the title
  // bar row (room for the window buttons, drags the window), the picture everything below.
  // One element tree for both sizes: the video and canvas the stream draws into, and the stage the
  // resize observers watch, must stay the same elements when the screen is expanded or collapsed.
  return (
    <section aria-label={`${machine.name} screen`} className={cn(fullscreen ? "fixed inset-0 z-40 flex flex-col bg-black" : "px-3 pt-3")}>
      {fullscreen ? (
        <div data-tauri-drag-region
          className={cn("flex h-11 shrink-0 select-none items-center gap-2 border-b border-white/10 bg-[#1b1c21] pr-2 text-white/85", isTauri && isMac ? "pl-[78px]" : "pl-3")}>
          <span className={cn("size-2 shrink-0 rounded-full", connected ? "bg-success" : "bg-white/30")} />
          <span data-tauri-drag-region className="text-[13px] font-semibold">{machine.name}</span>
          {rate && (
            <Tooltip content={readoutText(state.width, state.height, streamState.readout)}>
              <span className="flex items-center gap-1.5 text-[11px] tabular-nums text-white/60"><SignalBars bars={bars} />{rate}</span>
            </Tooltip>
          )}
          <div data-tauri-drag-region className="flex h-full flex-1 items-center gap-0.5 pl-2">{connected && tools}</div>
          {!connected && (
            <IconButton label="Back to the panel" className={tool} onClick={() => set({ fullscreen: false })}><Shrink /></IconButton>
          )}
        </div>
      ) : (
        <h3 className="mb-1.5 flex items-center gap-1.5 px-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Screen <span className="font-normal normal-case tracking-normal">{machine.name}</span>
        </h3>
      )}
      {screen}
    </section>
  );
}
