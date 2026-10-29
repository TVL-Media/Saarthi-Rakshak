import { SetMetadata } from '@nestjs/common';

export const APP_PUBLIC = 'app:public';
export const APP_NO_CONSENT = 'app:no-consent';

/** No login needed (app login, guardian pages). Every other /app route needs one. */
export const AppPublic = () => SetMetadata(APP_PUBLIC, true);

/** Works before the user has accepted the terms (me, consent, logout). */
export const NoConsentNeeded = () => SetMetadata(APP_NO_CONSENT, true);
