"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useQuery, useAction } from "convex/react";
import { api } from "../../../convex/_generated/api";
import {
  Send,
  Bot,
  User,
  Loader2,
  AlertCircle,
  Square,
  ChevronDown,
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
          <pre className="bg-background/60 border border-border/50 rounded-md p-2.5 mt-1.5 mb-2 overflow-x-auto text-xs font-mono whitespace-pre-wrap">
            {children}
          </pre>
        ),
        code: ({ className, children }) => {
          const isBlock = !!className;
          if (isBlock) {
            return <code className="font-mono text-xs">{children}</code>;
          }
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
        li: ({ children }) => <li className="leading-relaxed">{children}</li>,
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

// ─── Panel ────────────────────────────────────────────────────────────────────

export function AssistantPanel({ open, onClose }: AssistantPanelProps) {
  const dbMessages = useQuery(api.aiMessages.getContext);
  const chat = useAction(api.actions.aiAssistant.chat);

  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [noApiKey, setNoApiKey] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  // Optimistic user message shown while request is in-flight
  const [optimisticMsg, setOptimisticMsg] = useState<LocalMessage | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortedRef = useRef(false);

  // Combined message list — DB messages + optimistic in-flight message
  const messages: LocalMessage[] = [
    ...(dbMessages ?? []).map((m) => ({
      _id: m._id,
      role: m.role,
      content: m.content,
    })),
    ...(optimisticMsg ? [optimisticMsg] : []),
  ];

  // ── Scroll helpers ────────────────────────────────────────────────────────
  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "instant" });
  }, []);

  // Auto-scroll when DB messages arrive
  useEffect(() => {
    scrollToBottom();
  }, [dbMessages, scrollToBottom]);

  // Once DB syncs the optimistic message, drop it
  useEffect(() => {
    if (dbMessages && optimisticMsg && !loading) {
      setOptimisticMsg(null);
    }
  }, [dbMessages, loading, optimisticMsg]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setShowScrollBtn(el.scrollHeight - el.scrollTop - el.clientHeight > 80);
  };

  // Focus input on open
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 120);
  }, [open]);

  // ── Stop generation ───────────────────────────────────────────────────────
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

    const tempId = `opt-${Date.now()}`;
    setOptimisticMsg({ _id: tempId, role: "user", content: trimmed });
    setTimeout(() => scrollToBottom(true), 30);

    try {
      const result = (await chat({ message: trimmed })) as ChatResult;
      if (abortedRef.current) return;
      if ("error" in result && result.error === "no_api_key") {
        setNoApiKey(true);
      }
    } catch (err) {
      if (abortedRef.current) return;
      setErrorMsg(
        err instanceof Error ? err.message : "Something went wrong. Try again.",
      );
    } finally {
      if (!abortedRef.current) {
        setLoading(false);
      }
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
        {/* Header */}
        <SheetHeader className="px-4 py-4 border-b shrink-0">
          <div className="flex items-center gap-2">
            <Bot className="h-5 w-5 text-primary" />
            <SheetTitle className="text-base">AI Assistant</SheetTitle>
          </div>
          <SheetDescription className="text-xs">
            Ask about your video library, publishing schedule, or content strategy.
          </SheetDescription>
        </SheetHeader>

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

        {/* Messages + scroll-to-bottom button */}
        <div className="flex-1 min-h-0 relative">
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="h-full overflow-y-auto px-4 py-4 space-y-3"
          >
            {dbMessages === undefined ? (
              <div className="flex items-center justify-center h-full">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center gap-2">
                <Bot className="h-10 w-10 text-muted-foreground/50" />
                <p className="text-sm text-muted-foreground">
                  Start a conversation with your AI assistant.
                </p>
              </div>
            ) : (
              messages.map((msg) => (
                <div
                  key={msg._id}
                  className={cn(
                    "flex items-start gap-2",
                    msg.role === "user" ? "flex-row-reverse ml-6" : "mr-6",
                  )}
                >
                  {/* Avatar */}
                  <div
                    className={cn(
                      "h-7 w-7 rounded-full flex items-center justify-center shrink-0 mt-0.5",
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

                  {/* Bubble */}
                  <div
                    className={cn(
                      "rounded-2xl px-3 py-2 text-sm break-words min-w-0 flex-1",
                      msg.role === "user"
                        ? "bg-primary text-primary-foreground rounded-tr-sm whitespace-pre-wrap leading-relaxed"
                        : "bg-muted text-foreground rounded-tl-sm",
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
              <div className="flex items-start gap-2 mr-6">
                <div className="h-7 w-7 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5">
                  <Bot className="h-3.5 w-3.5 text-muted-foreground" />
                </div>
                <div className="rounded-2xl rounded-tl-sm bg-muted px-3 py-2.5 flex items-center gap-1">
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
              <Button
                size="icon"
                onClick={handleSend}
                disabled={!input.trim()}
              >
                <Send className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
