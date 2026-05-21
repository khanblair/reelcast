"use client";

import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { LoadingSpinner } from "@/components/shared/loading-spinner";
import { EmptyState } from "@/components/shared/empty-state";
import { Calendar, CheckCircle, Clock, XCircle } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { formatDistanceToNow } from "date-fns";
import { Badge } from "@/components/ui/badge";

export default function SchedulePage() {
  const jobs = useQuery(api.jobs.list);

  if (jobs === undefined) {
    return <div className="flex h-[80vh] items-center justify-center"><LoadingSpinner /></div>;
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "pending": return <Clock className="h-4 w-4 text-warning" />;
      case "processing": return <LoadingSpinner size="sm" />;
      case "completed": return <CheckCircle className="h-4 w-4 text-success" />;
      case "failed": return <XCircle className="h-4 w-4 text-destructive" />;
      default: return <Clock className="h-4 w-4" />;
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight mb-2">Job Queue</h1>
        <p className="text-muted-foreground">Monitor the status of your video generation and publishing tasks.</p>
      </div>

      {jobs.length > 0 ? (
        <Card>
          <CardContent className="p-0">
            <div className="divide-y">
              {jobs.map((job) => (
                <div key={job._id} className="flex items-center justify-between p-4">
                  <div className="flex items-center gap-4">
                    {getStatusIcon(job.status)}
                    <div>
                      <div className="font-medium flex items-center gap-2">
                        {job.type === "generation" ? "AI Generation" : "YouTube Publish"}
                        <Badge variant="outline" className="capitalize text-xs">
                          {job.status}
                        </Badge>
                      </div>
                      <div className="text-sm text-muted-foreground">
                        {job.startedAt ? (
                          <span>Started {formatDistanceToNow(job.startedAt, { addSuffix: true })}</span>
                        ) : (
                          <span>Created {formatDistanceToNow(job._creationTime, { addSuffix: true })}</span>
                        )}
                        {job.error && <span className="text-destructive ml-2">• Error: {job.error}</span>}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : (
        <EmptyState
          icon={Calendar}
          title="No jobs yet"
          description="Your scheduled generations and publishing tasks will appear here."
        />
      )}
    </div>
  );
}
