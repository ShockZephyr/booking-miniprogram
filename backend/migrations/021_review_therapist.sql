-- A review therapist is a normal user with a dedicated therapist binding.
-- Keep the original migration intact for existing installations.
ALTER TABLE users DROP CONSTRAINT users_review_identity_valid;
ALTER TABLE users ADD CONSTRAINT users_review_identity_valid CHECK (
  review_identity IS NULL OR (
    review_identity IN ('user', 'admin', 'therapist')
    AND openid = 'review:' || review_identity
    AND phone = 'review:' || review_identity
    AND role::text = CASE WHEN review_identity = 'admin' THEN 'admin' ELSE 'user' END
  )
);

ALTER TABLE therapists DROP CONSTRAINT therapists_phone_format;
ALTER TABLE therapists ADD CONSTRAINT therapists_phone_format CHECK (
  phone IS NULL OR phone ~ '^1[3-9][0-9]{9}$'
  OR (phone = 'review:therapist' AND user_id IS NOT NULL)
);
