export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/** Returns why a new password is not allowed, or null if it is fine. */
export function passwordProblem(password: string, email: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Password must be at most ${PASSWORD_MAX_LENGTH} characters`;
  }
  const localPart = email.split('@')[0].toLowerCase();
  if (localPart.length >= 4 && password.toLowerCase().includes(localPart)) {
    return 'Password must not contain your email name';
  }
  return null;
}
