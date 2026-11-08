-- Dedicated review identities never reuse a real phone or WeChat account.
ALTER TABLE users ADD COLUMN review_identity text;
ALTER TABLE users ADD CONSTRAINT users_review_identity_unique UNIQUE (review_identity);
ALTER TABLE users ADD CONSTRAINT users_review_identity_valid CHECK (
  review_identity IS NULL OR (
    review_identity IN ('user', 'admin')
    AND openid = 'review:' || review_identity
    AND phone = 'review:' || review_identity
    AND role::text = review_identity
  )
);
