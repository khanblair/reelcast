"use client";

import { useState } from "react";
import { useAction } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { LoadingSpinner } from "@/components/shared/loading-spinner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { TrendingUp, Search, Lightbulb, Info } from "lucide-react";

// ---------------------------------------------------------------------------
// Types matching actual Convex action return shapes
// ---------------------------------------------------------------------------

type TrendingVideo = {
  videoId: string;
  title: string;
  channelTitle: string;
  viewCount: number;
  likeCount: number;
  tags: string[];
  publishedAt: string;
};

type SearchResult = {
  videoId: string;
  title: string;
  channelTitle: string;
  description: string;
  publishedAt: string;
  thumbnailUrl: string;
};

type ContentGapsResult = {
  gaps: string[];
  competitorTopics: string[];
  userTopics: string[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatViews(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

function formatDate(isoString: string) {
  if (!isoString) return "";
  return new Date(isoString).toLocaleDateString("en-GB", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function IntelligencePage() {
  // Trending state
  const [trendingData, setTrendingData] = useState<TrendingVideo[]>([]);
  const [trendingLoading, setTrendingLoading] = useState(false);
  const [trendingError, setTrendingError] = useState<string | null>(null);
  const [trendingFetched, setTrendingFetched] = useState(false);

  // Keyword search state
  const [keyword, setKeyword] = useState("");
  const [searchData, setSearchData] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchFetched, setSearchFetched] = useState(false);

  // Content gaps state
  const [gapsData, setGapsData] = useState<ContentGapsResult | null>(null);
  const [gapsLoading, setGapsLoading] = useState(false);
  const [gapsError, setGapsError] = useState<string | null>(null);

  const fetchTrendingAction = useAction(api.actions.contentIntelligence.getTrendingTopics);
  const searchByKeywordAction = useAction(api.actions.contentIntelligence.searchByKeyword);
  const fetchGapsAction = useAction(api.actions.contentIntelligence.getContentGaps);

  async function handleFetchTrending() {
    setTrendingLoading(true);
    setTrendingError(null);
    try {
      const result = await fetchTrendingAction({});
      setTrendingData(result);
      setTrendingFetched(true);
    } catch (e) {
      setTrendingError(
        e instanceof Error ? e.message : "Failed to fetch trending topics"
      );
    } finally {
      setTrendingLoading(false);
    }
  }

  async function handleSearch() {
    const kw = keyword.trim();
    if (!kw) return;
    setSearchLoading(true);
    setSearchError(null);
    try {
      const result = await searchByKeywordAction({ keyword: kw });
      setSearchData(result);
      setSearchFetched(true);
    } catch (e) {
      setSearchError(
        e instanceof Error ? e.message : "Failed to search by keyword"
      );
    } finally {
      setSearchLoading(false);
    }
  }

  async function handleFetchGaps() {
    setGapsLoading(true);
    setGapsError(null);
    try {
      const result = await fetchGapsAction({});
      setGapsData(result);
    } catch (e) {
      setGapsError(
        e instanceof Error ? e.message : "Failed to analyze content gaps"
      );
    } finally {
      setGapsLoading(false);
    }
  }

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-2">
          Content Intelligence
        </h1>
        <p className="text-muted-foreground">
          Discover trending topics and content opportunities in your niche.
        </p>
      </div>

      {/* Info card */}
      <Card className="border-blue-200 bg-blue-50/50 dark:border-blue-800/50 dark:bg-blue-950/20">
        <CardContent className="flex items-start gap-3 pt-4 pb-4">
          <Info className="h-4 w-4 mt-0.5 shrink-0 text-blue-600 dark:text-blue-400" />
          <p className="text-sm text-blue-700 dark:text-blue-300">
            Results are fetched from the YouTube API and consume quota.
            Configure your niche in{" "}
            <span className="font-medium">Settings &rarr; AI</span> to get
            relevant results.
          </p>
        </CardContent>
      </Card>

      {/* ------------------------------------------------------------------ */}
      {/* Section 1: Trending Topics                                          */}
      {/* ------------------------------------------------------------------ */}
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-xl font-semibold tracking-tight">
            Trending Topics
          </h2>
          <Button onClick={handleFetchTrending} disabled={trendingLoading}>
            {trendingLoading ? (
              <span className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
            ) : (
              <TrendingUp className="mr-2 h-4 w-4" />
            )}
            Fetch Trending
          </Button>
        </div>

        {trendingError && (
          <p className="text-sm text-destructive">{trendingError}</p>
        )}

        {trendingLoading ? (
          <div className="flex items-center justify-center py-12">
            <LoadingSpinner />
          </div>
        ) : trendingFetched && trendingData.length === 0 ? (
          <Card>
            <CardContent className="flex items-center justify-center py-10">
              <p className="text-sm text-muted-foreground">
                No trending topics returned. Check your YouTube connection in
                Settings.
              </p>
            </CardContent>
          </Card>
        ) : trendingData.length > 0 ? (
          <div className="grid gap-4 sm:grid-cols-2">
            {trendingData.map((item) => (
              <Card key={item.videoId}>
                <CardContent className="pt-4 pb-4 space-y-1.5">
                  <p className="font-semibold text-sm leading-snug line-clamp-2">
                    {item.title}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {item.channelTitle}
                  </p>
                  <div className="flex items-center gap-2 pt-1">
                    <Badge variant="secondary">
                      {formatViews(item.viewCount)} views
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {formatDate(item.publishedAt)}
                    </span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <Card>
            <CardContent className="flex items-center justify-center py-10">
              <p className="text-sm text-muted-foreground">
                Click Fetch to load trending topics
              </p>
            </CardContent>
          </Card>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Section 2: Keyword Search                                           */}
      {/* ------------------------------------------------------------------ */}
      <div className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">
          Keyword Search
        </h2>

        <div className="flex gap-2">
          <Input
            placeholder="Enter a keyword..."
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSearch();
            }}
            className="max-w-xs"
          />
          <Button
            onClick={handleSearch}
            disabled={searchLoading || !keyword.trim()}
          >
            {searchLoading ? (
              <span className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
            ) : (
              <Search className="mr-2 h-4 w-4" />
            )}
            Search
          </Button>
        </div>

        {searchError && (
          <p className="text-sm text-destructive">{searchError}</p>
        )}

        {searchLoading ? (
          <div className="flex items-center justify-center py-12">
            <LoadingSpinner />
          </div>
        ) : searchFetched && searchData.length === 0 ? (
          <Card>
            <CardContent className="flex items-center justify-center py-10">
              <p className="text-sm text-muted-foreground">
                No results found for &ldquo;{keyword}&rdquo;.
              </p>
            </CardContent>
          </Card>
        ) : searchData.length > 0 ? (
          <div className="grid gap-4 sm:grid-cols-2">
            {searchData.map((item) => (
              <Card key={item.videoId}>
                <CardContent className="pt-4 pb-4 space-y-1.5">
                  <p className="font-semibold text-sm leading-snug line-clamp-2">
                    {item.title}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {item.channelTitle}
                  </p>
                  {item.description && (
                    <p className="text-xs text-muted-foreground line-clamp-2 pt-0.5">
                      {item.description}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground pt-1">
                    {formatDate(item.publishedAt)}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <Card>
            <CardContent className="flex items-center justify-center py-10">
              <p className="text-sm text-muted-foreground">
                Enter a keyword and click Search
              </p>
            </CardContent>
          </Card>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Section 3: Content Gaps                                             */}
      {/* ------------------------------------------------------------------ */}
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-xl font-semibold tracking-tight">
            Content Gaps
          </h2>
          <Button
            onClick={handleFetchGaps}
            disabled={gapsLoading}
            variant="outline"
          >
            {gapsLoading ? (
              <span className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
            ) : (
              <Lightbulb className="mr-2 h-4 w-4" />
            )}
            Analyze Gaps
          </Button>
        </div>

        {gapsError && (
          <p className="text-sm text-destructive">{gapsError}</p>
        )}

        {gapsLoading ? (
          <div className="flex items-center justify-center py-12">
            <LoadingSpinner />
          </div>
        ) : gapsData ? (
          <div className="space-y-6">
            {gapsData.gaps.length > 0 ? (
              <div className="space-y-3">
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Opportunity Topics — trending but not yet in your library
                </h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  {gapsData.gaps.map((topic, i) => (
                    <Card key={i}>
                      <CardContent className="pt-4 pb-4 flex items-center justify-between gap-2">
                        <p className="text-sm font-medium">{topic}</p>
                        <Badge className="bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300 shrink-0">
                          Gap
                        </Badge>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            ) : (
              <Card>
                <CardContent className="flex items-center justify-center py-10">
                  <p className="text-sm text-muted-foreground">
                    No gaps found — your content is well-aligned with trending
                    topics.
                  </p>
                </CardContent>
              </Card>
            )}

            {gapsData.userTopics.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Your Covered Topics
                </h3>
                <div className="flex flex-wrap gap-2">
                  {gapsData.userTopics.map((topic, i) => (
                    <Badge key={i} variant="secondary">
                      {topic}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <Card>
            <CardContent className="flex items-center justify-center py-10">
              <p className="text-sm text-muted-foreground">
                Click Analyze to identify content opportunities
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
