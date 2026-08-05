"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useQuery, useAction, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import {
  Send,
  Bot,
  User,
  Loader2,
  AlertCircle,
  Square,
  ChevronDown,
  MoreHorizontal,
  Plus,
  Trash2,
  ChevronLeft,
  MessageSquare,
} from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import Link from "next/link";
import type { Route } from "next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AssistantPanelProps {
  open: boolean;
  onClose: () => void;
}

type ChatResult = { response: string } | { error: "no_api_key" };

interface LocalMessage {
  _id: string;
  role: "user" | "assistant";
  content: string;
}

// ─── Markdown renderer ────────────────────────────────────────────────────────

function MarkdownContent({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => (
          <p className="mb-2 last:mb-0 leading-relaxed">{children}</p>
        ),
        strong: ({ children }) => (
          <strong className="font-semibold">{children}</strong>
        ),
        em: ({ children }) => <em className="italic">{children}</em>,
        pre: ({ children }) => (
          <pre className="bg-background/60 border border-border/40 rounded-md p-2.5 mt-1.5 mb-2 overflow-x-auto text-xs font-mono whitespace-pre-wrap">
            {children}
          </pre>
        ),
        code: ({ className, children }) => {
          const isBlock = !!className;
          if (isBlock)
            return <code className="font-mono text-xs">{children}</code>;
          return (
            <code className="bg-background/60 border border-border/40 rounded px-1 py-0.5 text-xs font-mono">
              {children}
            </code>
          );
        },
        ul: ({ children }) => (
          <ul className="list-disc list-inside mb-2 space-y-0.5 pl-1">
            {children}
          </ul>
        ),
        ol: ({ children }) => (
          <ol className="list-decimal list-inside mb-2 space-y-0.5 pl-1">
            {children}
          </ol>
        ),
        li: ({ children }) => (
          <li className="leading-relaxed">{children}</li>
        ),
        h1: ({ children }) => (
          <h1 className="text-base font-bold mb-1.5 mt-2">{children}</h1>
        ),
        h2: ({ children }) => (
          <h2 className="text-sm font-bold mb-1 mt-2">{children}</h2>
        ),
        h3: ({ children }) => (
          <h3 className="text-sm font-semibold mb-1 mt-1.5">{children}</h3>
        ),
        table: ({ children }) => (
          <div className="overflow-x-auto my-2 rounded-md border border-border/50">
            <table className="w-full text-xs border-collapse">{children}</table>
          </div>
        ),
        thead: ({ children }) => (
          <thead className="bg-background/40">{children}</thead>
        ),
        th: ({ children }) => (
          <th className="border-b border-border/50 px-2.5 py-1.5 font-semibold text-left">
            {children}
          </th>
        ),
        td: ({ children }) => (
          <td className="border-b border-border/30 px-2.5 py-1.5">{children}</td>
        ),
        blockquote: ({ children }) => (
          <blockquote className="border-l-2 border-primary/40 pl-3 my-1.5 opacity-80 italic">
            {children}
          </blockquote>
        ),
        a: ({ href, children }) => (
          <a
            href={href}
            className="text-primary underline underline-offset-2 hover:opacity-75"
            target="_blank"
            rel="noopener noreferrer"
          >
            {children}
          </a>
        ),
        hr: () => <hr className="my-2 border-border/50" />,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

// ─── History / session list view ──────────────────────────────────────────────

function SessionList({
  sessions,
  currentSessionId,
  onSelect,
  onDelete,
  onNewChat,
  onBack,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sessions: any[];
  currentSessionId: Id<"aiSessions"> | null;
  onSelect: (id: Id<"aiSessions">) => void;
  onDelete: (id: Id<"aiSessions">) => void;
  onNewChat: () => void;
  onBack: () => void;
}) {
  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Sub-header */}
      <div className="px-4 py-2.5 border-b flex items-center gap-2 shrink-0">
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onBack}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="text-sm font-medium">Conversations</span>
      </div>

      {/* New chat */}
      <div className="px-3 py-2.5 border-b shrink-0">
        <Button
          variant="outline"
          size="sm"
          className="w-full gap-2 justify-start"
          onClick={onNewChat}
        >
          <Plus className="h-4 w-4" />
          New chat
        </Button>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto py-1">
        {sessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-center px-4 py-8">
            <MessageSquare className="h-8 w-8 text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground">No conversations yet</p>
          </div>
        ) : (
          sessions.map((session) => {
            const isActive = session._id === currentSessionId;
            const title = session.title ?? "New conversation";
            const date = new Date(session.lastMessageAt).toLocaleDateString(
              "en-US",
              { month: "short", day: "numeric" },
            );
            return (
              <div
                key={session._id}
                className={cn(
                  "group flex items-center gap-2 px-3 py-2.5 cursor-pointer transition-colors hover:bg-accent/50",
                  isActive && "bg-accent",
                )}
                onClick={() => onSelect(session._id)}
              >
                <MessageSquare className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm truncate">{title}</p>
                  <p className="text-[10px] text-muted-foreground">{date}</p>
                </div>
                <button
                  className="h-6 w-6 rounded flex items-center justify-center text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive hover:bg-destructive/10 transition-all shrink-0"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(session._id);
                  }}
                  title="Delete conversation"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export function AssistantPanel({ open, onClose }: AssistantPanelProps) {
  const sessions = useQuery(api.aiSessions.list);
  const createSession = useMutation(api.aiSessions.create);
  const removeSession = useMutation(api.aiSessions.remove);
  const updateTitle = useMutation(api.aiSessions.updateTitle);
  const chat = useAction(api.actions.aiAssistant.chat);

  const [currentSessionId, setCurrentSessionId] =
    useState<Id<"aiSessions"> | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [noApiKey, setNoApiKey] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [optimisticMsg, setOptimisticMsg] = useState<LocalMessage | null>(null);
  const [hasAutoSelected, setHasAutoSelected] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortedRef = useRef(false);

  // Query messages for the active session
  const dbMessages = useQuery(
    api.aiMessages.getContext,
    currentSessionId ? { sessionId: currentSessionId } : "skip",
  );

  // Auto-select the most recent session on first load
  useEffect(() => {
    if (!hasAutoSelected && sessions && sessions.length > 0) {
      setCurrentSessionId(sessions[0]._id as Id<"aiSessions">);
      setHasAutoSelected(true);
    }
  }, [sessions, hasAutoSelected]);

  // Combined messages: DB + optimistic
  const messages: LocalMessage[] = [
    ...(dbMessages ?? []).map((m) => ({
      _id: m._id,
      role: m.role,
      content: m.content,
    })),
    ...(optimisticMsg ? [optimisticMsg] : []),
  ];

  // ── Scroll ────────────────────────────────────────────────────────────────
  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "instant" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [dbMessages, scrollToBottom]);

  useEffect(() => {
    if (dbMessages && optimisticMsg && !loading) setOptimisticMsg(null);
  }, [dbMessages, loading, optimisticMsg]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setShowScrollBtn(el.scrollHeight - el.scrollTop - el.clientHeight > 80);
  };

  useEffect(() => {
    if (open && !showHistory) {
      setTimeout(() => inputRef.current?.focus(), 120);
    }
  }, [open, showHistory]);

  // ── Session actions ───────────────────────────────────────────────────────
  const handleNewChat = () => {
    setCurrentSessionId(null);
    setOptimisticMsg(null);
    setLoading(false);
    setNoApiKey(false);
    setErrorMsg(null);
    setShowHistory(false);
    abortedRef.current = true;
  };

  const handleSelectSession = (id: Id<"aiSessions">) => {
    setCurrentSessionId(id);
    setOptimisticMsg(null);
    setShowHistory(false);
  };

  const handleDeleteSession = async (id: Id<"aiSessions">) => {
    if (currentSessionId === id) {
      // Find the next session to switch to
      const remaining = (sessions ?? []).filter((s) => s._id !== id);
      setCurrentSessionId(
        remaining.length > 0 ? (remaining[0]._id as Id<"aiSessions">) : null,
      );
    }
    await removeSession({ sessionId: id });
  };

  // ── Stop ──────────────────────────────────────────────────────────────────
  const handleStop = () => {
    abortedRef.current = true;
    setLoading(false);
    setOptimisticMsg(null);
  };

  // ── Send ──────────────────────────────────────────────────────────────────
  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || loading) return;

    abortedRef.current = false;
    setInput("");
    setLoading(true);
    setNoApiKey(false);
    setErrorMsg(null);

    // Ensure a session exists
    let sessionId = currentSessionId;
    if (!sessionId) {
      const title = trimmed.slice(0, 50);
      sessionId = (await createSession({ title })) as Id<"aiSessions">;
      setCurrentSessionId(sessionId);
    } else if ((dbMessages ?? []).length === 0) {
      // Update title from first message of existing session
      await updateTitle({ sessionId, title: trimmed.slice(0, 50) });
    }

    // Optimistic user message
    setOptimisticMsg({ _id: `opt-${Date.now()}`, role: "user", content: trimmed });
    setTimeout(() => scrollToBottom(true), 30);

    try {
      const result = (await chat({ message: trimmed, sessionId })) as ChatResult;
      if (abortedRef.current) return;
      if ("error" in result && result.error === "no_api_key") setNoApiKey(true);
    } catch (err) {
      if (abortedRef.current) return;
      setErrorMsg(
        err instanceof Error ? err.message : "Something went wrong. Try again.",
      );
    } finally {
      if (!abortedRef.current) setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-md flex flex-col p-0">

        {/* ── Header ── */}
        <SheetHeader className="px-4 py-3 border-b shrink-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Bot className="h-5 w-5 text-primary" />
              <SheetTitle className="text-base">AI Assistant</SheetTitle>
            </div>
            <button
              onClick={() => setShowHistory((v) => !v)}
              className={cn(
                "h-7 w-7 rounded-md flex items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                showHistory && "bg-accent text-foreground",
              )}
              title="Conversations"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </div>
          {!showHistory && (
            <SheetDescription className="text-xs">
              Ask about your video library, publishing schedule, or content strategy.
            </SheetDescription>
          )}
        </SheetHeader>

        {/* ── History view ── */}
        {showHistory ? (
          <SessionList
            sessions={sessions ?? []}
            currentSessionId={currentSessionId}
            onSelect={handleSelectSession}
            onDelete={handleDeleteSession}
            onNewChat={handleNewChat}
            onBack={() => setShowHistory(false)}
          />
        ) : (
          <>
            {/* Banners */}
            {noApiKey && (
              <div className="mx-4 mt-3 flex items-start gap-2 rounded-lg border border-yellow-300 bg-yellow-50/60 dark:border-yellow-800 dark:bg-yellow-950/30 p-3 text-sm text-yellow-800 dark:text-yellow-300 shrink-0">
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>
                  No DeepSeek API key configured.{" "}
                  <Link
                    href={"/settings/ai" as Route}
                    className="underline underline-offset-2 font-medium"
                    onClick={onClose}
                  >
                    Add your key in Settings
                  </Link>
                  .
                </span>
              </div>
            )}
            {errorMsg && (
              <div className="mx-4 mt-3 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive shrink-0">
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                {errorMsg}
              </div>
            )}

            {/* Messages */}
            <div className="flex-1 min-h-0 relative">
              <div
                ref={scrollRef}
                onScroll={handleScroll}
                className="h-full overflow-y-auto px-4 py-4 space-y-3"
              >
                {dbMessages === undefined && currentSessionId ? (
                  <div className="flex items-center justify-center h-full">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : messages.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full text-center gap-3 px-4">
                    <Bot className="h-10 w-10 text-muted-foreground/40" />
                    <div>
                      <p className="text-sm font-medium">Start a new conversation</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Ask about your library, schedule, or content ideas.
                      </p>
                    </div>
                  </div>
                ) : (
                  messages.map((msg) => (
                    <div
                      key={msg._id}
                      className={cn(
                        "flex items-end gap-2",
                        msg.role === "user" ? "flex-row-reverse" : "",
                      )}
                    >
                      {/* Avatar */}
                      <div
                        className={cn(
                          "h-7 w-7 rounded-full flex items-center justify-center shrink-0 mb-0.5",
                          msg.role === "user"
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground",
                        )}
                      >
                        {msg.role === "user" ? (
                          <User className="h-3.5 w-3.5" />
                        ) : (
                          <Bot className="h-3.5 w-3.5" />
                        )}
                      </div>

                      {/* Bubble — max 75% width, auto-sized to content */}
                      <div
                        className={cn(
                          "rounded-2xl px-3 py-2 text-sm break-words",
                          // 75% max so it never spans the full width
                          "max-w-[75%]",
                          msg.role === "user"
                            ? "bg-primary text-primary-foreground rounded-br-sm whitespace-pre-wrap leading-relaxed"
                            : "bg-muted text-foreground rounded-bl-sm",
                        )}
                      >
                        {msg.role === "assistant" ? (
                          <MarkdownContent content={msg.content} />
                        ) : (
                          msg.content
                        )}
                      </div>
                    </div>
                  ))
                )}

                {/* Typing indicator */}
                {loading && (
                  <div className="flex items-end gap-2">
                    <div className="h-7 w-7 rounded-full bg-muted flex items-center justify-center shrink-0 mb-0.5">
                      <Bot className="h-3.5 w-3.5 text-muted-foreground" />
                    </div>
                    <div className="rounded-2xl rounded-bl-sm bg-muted px-3 py-2.5 flex items-center gap-1">
                      <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:0ms]" />
                      <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:150ms]" />
                      <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:300ms]" />
                    </div>
                  </div>
                )}
              </div>

              {/* Scroll-to-bottom button */}
              {showScrollBtn && (
                <button
                  onClick={() => scrollToBottom(true)}
                  className="absolute bottom-3 right-3 z-10 h-8 w-8 rounded-full bg-primary text-primary-foreground shadow-lg flex items-center justify-center hover:bg-primary/90 transition-colors"
                  aria-label="Scroll to bottom"
                >
                  <ChevronDown className="h-4 w-4" />
                </button>
              )}
            </div>

            {/* Input bar */}
            <div className="px-4 py-3 border-t shrink-0">
              <div className="flex gap-2">
                <Input
                  ref={inputRef}
                  placeholder="Ask anything about your library..."
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={loading}
                  className="flex-1"
                />
                {loading ? (
                  <Button
                    size="icon"
                    variant="outline"
                    onClick={handleStop}
                    title="Stop generation"
                  >
                    <Square className="h-3.5 w-3.5 fill-current" />
                  </Button>
                ) : (
                  <Button size="icon" onClick={handleSend} disabled={!input.trim()}>
                    <Send className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
