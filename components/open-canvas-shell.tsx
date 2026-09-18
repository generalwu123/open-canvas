'use client';

import { useRef } from 'react';
import { toast } from 'sonner';

import { exportCanvasToJson, importCanvasFromJsonFile } from '@/lib/canvas-json';
import { useRouter } from '@/i18n/navigation';
import { CanvasStudioShell } from '@/shared/blocks/canvas/canvas-studio-shell';
import { canvasT } from '@/shared/lib/canvas/i18n';
import { useCanvasTranslations } from '@/shared/lib/canvas/use-canvas-translations';
import type { CanvasDocumentRecord } from '@/shared/lib/canvas/types';

export function OpenCanvasShell({
  initialCanvas,
}: {
  initialCanvas: CanvasDocumentRecord;
}) {
  const router = useRouter();
  const t = useCanvasTranslations();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleExportCanvas = async () => {
    try {
      await exportCanvasToJson(initialCanvas.id);
      toast.success(canvasT(t, 'toast.exportCanvasSuccess'));
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : canvasT(t, 'toast.exportCanvasFailed')
      );
    }
  };

  const handleImportCanvas = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }

    try {
      const result = await importCanvasFromJsonFile(file);
      toast.success(canvasT(t, 'toast.importCanvasSuccess', { title: result.title }));
      router.push(`/canvas/${result.canvasId}`);
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : canvasT(t, 'toast.importFileFailed', { name: file.name })
      );
    }
  };

  return (
    <>
      <CanvasStudioShell
        initialCanvas={initialCanvas}
        onImportJson={() => fileInputRef.current?.click()}
        onExportJson={() => void handleExportCanvas()}
      />

      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={handleImportCanvas}
      />
    </>
  );
}
