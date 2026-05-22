import { Redirect, useLocalSearchParams } from 'expo-router';

const MATERIAL_REVIEW_LECTURE_ID = '__material_review__';

export default function MaterialReaderRedirect() {
  const params = useLocalSearchParams<{ id?: string }>();
  const id = params.id ?? '';

  return (
    <Redirect
      href={{
        pathname: '/lecture-material/[lectureId]/[materialId]',
        params: { lectureId: MATERIAL_REVIEW_LECTURE_ID, materialId: id },
      }}
    />
  );
}
