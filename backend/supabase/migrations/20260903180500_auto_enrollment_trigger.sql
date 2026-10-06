-- Auto-enroll students when an exam is published or scheduled
CREATE OR REPLACE FUNCTION public.auto_enroll_students_for_exam()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status <> 'draft' THEN
    -- Enroll students into public.enrollments
    INSERT INTO public.enrollments (exam_id, student_id)
    SELECT NEW.id, s.id
    FROM public.students s
    ON CONFLICT (exam_id, student_id) DO NOTHING;

    -- Also enroll into public.exam_enrollments if auth_id exists
    INSERT INTO public.exam_enrollments (exam_id, student_id, access_status)
    SELECT NEW.id, s.auth_id, 'allowed'
    FROM public.students s
    WHERE s.auth_id IS NOT NULL
    ON CONFLICT (exam_id, student_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_auto_enroll_students ON public.exams;
CREATE TRIGGER trigger_auto_enroll_students
AFTER INSERT OR UPDATE ON public.exams
FOR EACH ROW
EXECUTE FUNCTION public.auto_enroll_students_for_exam();

-- Backfill enrollments for existing exams
INSERT INTO public.enrollments (exam_id, student_id)
SELECT e.id, s.id
FROM public.exams e
CROSS JOIN public.students s
WHERE e.status <> 'draft'
ON CONFLICT (exam_id, student_id) DO NOTHING;

INSERT INTO public.exam_enrollments (exam_id, student_id, access_status)
SELECT e.id, s.auth_id, 'allowed'
FROM public.exams e
CROSS JOIN public.students s
WHERE e.status <> 'draft' AND s.auth_id IS NOT NULL
ON CONFLICT (exam_id, student_id) DO NOTHING;
