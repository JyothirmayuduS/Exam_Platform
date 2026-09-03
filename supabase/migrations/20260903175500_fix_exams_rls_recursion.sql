-- Fix infinite recursion detected in policy for relation "exams"
-- The recursion happened because exams policy queried exam_enrollments,
-- and exam_enrollments policy queried exams back directly.

-- 1. Create SECURITY DEFINER functions to break mutual RLS recursion
CREATE OR REPLACE FUNCTION public.check_student_enrolled_in_exam(p_exam_id text, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.exam_enrollments
    WHERE exam_id = p_exam_id
      AND student_id = p_user_id
      AND access_status = 'allowed'
  );
$$;

CREATE OR REPLACE FUNCTION public.check_user_created_exam(p_exam_id text, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.exams
    WHERE id = p_exam_id
      AND created_by = p_user_id
  );
$$;

-- 2. Set default for created_by on exams
ALTER TABLE public.exams ALTER COLUMN created_by SET DEFAULT auth.uid();

-- 3. Replace recursive policies on exams
DROP POLICY IF EXISTS "exams_students_select" ON public.exams;
CREATE POLICY "exams_students_select" ON public.exams
FOR SELECT TO authenticated
USING (
  public.check_student_enrolled_in_exam(id, auth.uid())
);

-- 4. Replace recursive policies on exam_enrollments
DROP POLICY IF EXISTS "exam_enrollments_teachers_all" ON public.exam_enrollments;
CREATE POLICY "exam_enrollments_teachers_all" ON public.exam_enrollments
FOR ALL TO authenticated
USING (
  public.check_user_created_exam(exam_id, auth.uid())
);

-- 5. Consolidate and fix teacher management policy on exams
DROP POLICY IF EXISTS "exams_teachers_all" ON public.exams;
DROP POLICY IF EXISTS "teachers manage own exams" ON public.exams;
DROP POLICY IF EXISTS "demo exams write" ON public.exams;

CREATE POLICY "teachers manage own exams" ON public.exams
FOR ALL TO authenticated
USING (
  created_by = auth.uid() 
  OR created_by IS NULL
  OR EXISTS (SELECT 1 FROM public.teachers WHERE auth_id = auth.uid())
)
WITH CHECK (
  created_by = auth.uid() 
  OR created_by IS NULL
  OR EXISTS (SELECT 1 FROM public.teachers WHERE auth_id = auth.uid())
);
