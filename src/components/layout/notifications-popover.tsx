"use client";

import { useQuery, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Bell, Check, Trash2, Loader2, Info, AlertCircle, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";

export function NotificationsPopover() {
  const notifications = useQuery(api.notifications.get);
  const markAsRead = useMutation(api.notifications.markAsRead);
  const markAllAsRead = useMutation(api.notifications.markAllAsRead);
  const clearAll = useMutation(api.notifications.clearAll);

  const unreadCount = notifications?.filter((n: any) => !n.isRead).length || 0;

  const handleMarkAsRead = async (id: any) => {
    await markAsRead({ notificationId: id });
  };

  const getIcon = (type: string) => {
    switch (type) {
      case "success": return <CheckCircle2 className="h-4 w-4 text-green-500" />;
      case "error": return <AlertCircle className="h-4 w-4 text-red-500" />;
      case "warning": return <AlertCircle className="h-4 w-4 text-yellow-500" />;
      default: return <Info className="h-4 w-4 text-blue-500" />;
    }
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative">
          <Bell className="h-5 w-5 text-muted-foreground" />
          {unreadCount > 0 && (
            <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-primary" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="end">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h4 className="font-semibold text-sm">Notifications</h4>
          {unreadCount > 0 && (
            <Button variant="ghost" size="sm" className="h-auto p-0 text-xs" onClick={() => markAllAsRead()}>
              Mark all as read
            </Button>
          )}
        </div>
        
        <ScrollArea className="h-80">
          {notifications === undefined ? (
            <div className="flex h-32 items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : notifications.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-32 text-center px-4">
              <Bell className="h-8 w-8 text-muted-foreground/30 mb-2" />
              <p className="text-sm text-muted-foreground">You don't have any notifications yet.</p>
            </div>
          ) : (
            <div className="flex flex-col">
              {notifications.map((notification: any) => (
                <div 
                  key={notification._id}
                  className={cn(
                    "flex gap-3 p-4 border-b last:border-0 hover:bg-muted/50 transition-colors cursor-pointer",
                    !notification.isRead ? "bg-primary/5" : ""
                  )}
                  onClick={() => !notification.isRead && handleMarkAsRead(notification._id)}
                >
                  <div className="mt-0.5 flex-shrink-0">
                    {getIcon(notification.type)}
                  </div>
                  <div className="flex-1 space-y-1">
                    <p className="text-sm font-medium leading-none">{notification.title}</p>
                    <p className="text-xs text-muted-foreground line-clamp-2">{notification.message}</p>
                    <p className="text-[10px] text-muted-foreground pt-1">
                      {formatDistanceToNow(notification._creationTime, { addSuffix: true })}
                    </p>
                  </div>
                  {!notification.isRead && (
                    <div className="flex-shrink-0 flex items-center">
                      <span className="h-2 w-2 rounded-full bg-primary" />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
        
        {notifications && notifications.length > 0 && (
          <div className="p-2 border-t">
            <Button 
              variant="ghost" 
              size="sm" 
              className="w-full text-xs text-muted-foreground hover:text-foreground"
              onClick={() => clearAll()}
            >
              <Trash2 className="h-3 w-3 mr-2" />
              Clear all notifications
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
