import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { LectureDocumentEditor } from '@/components/LectureDocumentEditor';
import { getTranscriptSectionLabel, resolveLectureLanguagePair } from '@/lib/contentLanguages.mjs';
import { useI18n } from '@/lib/i18n';
import { useData } from '@/lib/store';
import {
  buildTranscriptEditPatch,
  getEditableTranscriptText,
  isTranscriptDraftDirty,
} from '@/lib/transcriptEdit.mjs';

type TranscriptEditSide = 'source' | 'translated';

function resolveSide(raw: string | undefined): TranscriptEditSide | null {
  if (raw === 'source' || raw === 'translated') return raw;
  return null;
}

export default function TranscriptEditScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string; side?: string }>();
  const { getLecture, updateLecture } = useData();
  const lecture = getLecture(params.id);
  const side = resolveSide(typeof params.side === 'string' ? params.side : undefined);

  const [draft, setDraft] = useState('');
  const seededRef = useRef(false);
  useEffect(() => {
    if (!lecture || !side || seededRef.current) return;
    setDraft(getEditableTranscriptText(lecture, side));
    seededRef.current = true;
  }, [lecture, side]);

  const title = useMemo(() => {
    if (!lecture || !side) return t('lecture.transcriptEditTitle');
    const { sourceLanguage, translationLanguage } = resolveLectureLanguagePair(lecture);
    const language = side === 'source' ? sourceLanguage : translationLanguage;
    return getTranscriptSectionLabel(language);
  }, [lecture, side, t]);

  const contentLanguage = useMemo(() => {
    if (!lecture || !side) return 'en';
    const { sourceLanguage, translationLanguage } = resolveLectureLanguagePair(lecture);
    return side === 'source' ? sourceLanguage : translationLanguage;
  }, [lecture, side]);

  const dirty = lecture && side ? isTranscriptDraftDirty(lecture, side, draft) : false;
  const emptyConfirmTitle =
    contentLanguage === 'zh-Hans'
      ? t('lecture.transcriptSaveEmptyZh')
      : t('lecture.transcriptSaveEmptyEn');

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else if (params.id) router.replace({ pathname: '/lecture/[id]', params: { id: params.id } });
    else router.replace('/');
  }, [params.id, router]);

  const persist = useCallback(() => {
    if (!lecture || !side) return;
    updateLecture(lecture.id, buildTranscriptEditPatch(lecture, side, draft));
    leave();
  }, [draft, leave, lecture, side, updateLecture]);

  return (
    <LectureDocumentEditor
      missing={!lecture || !side}
      title={title}
      draft={draft}
      onChangeDraft={setDraft}
      placeholder={t('lecture.transcriptEditPlaceholder')}
      dirty={dirty}
      onLeave={leave}
      onPersist={persist}
      emptyConfirmTitle={emptyConfirmTitle}
      emptyConfirmBody={t('lecture.transcriptSaveEmptyBody')}
    />
  );
}
