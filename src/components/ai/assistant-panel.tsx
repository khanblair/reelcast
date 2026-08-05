"use client";

import { useState, useRef, useEffect } from "react";
import { useQuery, useAction } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Send, Bot, User, Loader2, AlertCircle } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import Link from "next/link";
import type { Route } from "next";

interface AssistantPanelProps {
  open: boolean;
  onClose: () => void;
}

type ChatResult =
  | { response: string }
  | { error: "no_api_key" };

export function AssistantPanel({ open, onClose }: AssistantPanelProps) {
  const messages = useQuery(api.aiMessages.getContext);
  const chat = useAction(api.actions.aiAssistant.chat);

  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [noApiKey, setNoApiKey] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Focus input when panel opens
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open]);

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || loading) return;

    setInput("");
    setLoading(true);
    setNoApiKey(false);
    setErrorMsg(null);

    try {
      const result = await chat({ message: trimmed }) as ChatResult;
      if ("error" in result && result.error === "no_api_key") {
        setNoApiKey(true);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
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
        <SheetHeader className="px-4 py-4 border-b shrink-0">
          <div className="flex items-center gap-2">
            <Bot className="h-5 w-5 text-primary" />
            <SheetTitle className="text-base">AI Assistant</SheetTitle>
          </div>
          <SheetDescription className="text-xs">
            Ask about your video library, publishing schedule, or content strategy.
          </SheetDescription>
        </SheetHeader>

        {/* No API key warning */}
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

        {/* Error */}
        {errorMsg && (
          <div className="mx-4 mt-3 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive shrink-0">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            {errorMsg}
          </div>
        )}

        {/* Messages area */}
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto px-4 py-4 space-y-3 min-h-0"
        >
          {messages === undefined ? (
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
                  "flex items-start gap-2 max-w-[85%]",
                  msg.role === "user" ? "ml-auto flex-row-reverse" : ""
                )}
              >
                {/* Avatar */}
                <div className={cn(
                  "h-7 w-7 rounded-full flex items-center justify-center shrink-0",
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground"
                )}>
                  {msg.role === "user"
                    ? <User className="h-3.5 w-3.5" />
                    : <Bot className="h-3.5 w-3.5" />
                  }
                </div>

                {/* Bubble */}
                <div
                  className={cn(
                    "rounded-2xl px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words",
                    msg.role === "user"
                      ? "bg-primary text-primary-foreground rounded-tr-sm"
                      : "bg-muted text-foreground rounded-tl-sm"
                  )}
                >
                  {msg.content}
                </div>
              </div>
            ))
          )}

          {/* Loading indicator */}
          {loading && (
            <div className="flex items-start gap-2 max-w-[85%]">
              <div className="h-7 w-7 rounded-full bg-muted flex items-center justify-center shrink-0">
                <Bot className="h-3.5 w-3.5 text-muted-foreground" />
              </div>
              <div className="rounded-2xl rounded-tl-sm bg-muted px-3 py-2">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            </div>
          )}
        </div>

        {/* Input area */}
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
            <Button
              size="icon"
              onClick={handleSend}
              disabled={loading || !input.trim()}
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
