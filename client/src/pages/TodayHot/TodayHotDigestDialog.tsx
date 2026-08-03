import React, { useState, useCallback } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { FileText } from 'lucide-react';
import { toast } from 'sonner';
import { logger } from '@lark-apaas/client-toolkit/logger';
import { getDailyDigest } from '@/api/article';
import type { DailyDigest, Direction } from '@shared/api.interface';

interface DirectionConfig {
  key: string;
  label: string;
  bg: string;
  fg: string;
}

interface DigestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  directions: readonly DirectionConfig[];
}

export function DigestDialog({
  open,
  onOpenChange,
  directions,
}: DigestDialogProps): React.ReactElement {
  const [digest, setDigest] = useState<DailyDigest | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [notFound, setNotFound] = useState<boolean>(false);

  const directionMap = new Map(
    directions.map((d: DirectionConfig) => [d.key, d]),
  );

  const handleOpenChange = useCallback(
    (nextOpen: boolean): void => {
      if (nextOpen && !digest) {
        const today: string = new Date()
          .toISOString()
          .split('T')[0];
        setLoading(true);
        setNotFound(false);
        getDailyDigest(today)
          .then((data: DailyDigest) => {
            setDigest(data);
          })
          .catch((err: unknown) => {
            logger.error(
              `Failed to fetch digest: ${String(err)}`,
            );
            setNotFound(true);
            toast.error('获取今日简报失败');
          })
          .finally(() => {
            setLoading(false);
          });
      }
      if (!nextOpen) {
        setDigest(null);
        setNotFound(false);
      }
      onOpenChange(nextOpen);
    },
    [digest, onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="size-5" />
            今日简报
          </DialogTitle>
        </DialogHeader>

        {loading && (
          <p className="text-sm text-muted-foreground py-8 text-center">
            加载中...
          </p>
        )}

        {notFound && !loading && (
          <p className="text-sm text-muted-foreground py-8 text-center">
            今日简报尚未生成
          </p>
        )}

        {digest && !loading && (
          <div className="flex flex-col gap-4">
            <p className="text-xs text-muted-foreground">
              {digest.digestDate} · 共 {digest.articleCount} 条
            </p>
            <p className="text-sm leading-relaxed">{digest.summary}</p>
            <div className="flex flex-col gap-2">
              {digest.articles.map(
                (article: {
                  id: string;
                  title: string;
                  primaryDirection: Direction;
                  primaryScore: number;
                }) => {
                  const dirConf = directionMap.get(
                    article.primaryDirection,
                  );
                  return (
                    <div
                      key={article.id}
                      className="flex items-center justify-between gap-3 p-3 border rounded-sm"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        {dirConf && (
                          <Badge
                            variant="outline"
                            className="rounded-full shrink-0 text-[10px] px-2"
                            style={{
                              backgroundColor: dirConf.bg,
                              color: dirConf.fg,
                              borderColor: dirConf.bg,
                            }}
                          >
                            {dirConf.label}
                          </Badge>
                        )}
                        <span className="text-sm truncate">
                          {article.title}
                        </span>
                      </div>
                      <span className="font-mono text-lg font-bold text-primary shrink-0">
                        {article.primaryScore}
                      </span>
                    </div>
                  );
                },
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
