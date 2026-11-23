import { getApp, getApps, initializeApp } from 'firebase/app';
import {
  browserLocalPersistence,
  browserPopupRedirectResolver,
  browserSessionPersistence,
  getAuth,
  GoogleAuthProvider,
  initializeAuth,
  inMemoryPersistence,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type Auth,
  type User as FirebaseUser,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';
import { isFirebasePopupPendingPromiseError } from './validation';

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);

function initIframeSafeAuth(): Auth {
  try {
    // Avoid indexedDBLocalPersistence inside cross-origin iframes, where slow/blocked
    // IndexedDB transactions can stall signInWithPopup past the popup close timer and
    // trigger Firebase Auth's "Pending promise was never set" race condition.
    return initializeAuth(app, {
      persistence: [
        browserLocalPersistence,
        browserSessionPersistence,
        inMemoryPersistence,
      ],
      popupRedirectResolver: browserPopupRedirectResolver,
    });
  } catch {
    return getAuth(app);
  }
}

export const auth = initIframeSafeAuth();
export const googleAuthProvider = new GoogleAuthProvider();
googleAuthProvider.setCustomParameters({ prompt: 'select_account' });

// Guard against the known @firebase/auth v13 PopupOperation.onAuthEvent race where an
// in-flight signInWithIdp response settles after pollUserCancellation clears pendingPromise.
if (typeof window !== 'undefined') {
  const globalGuardKey = '__clipgeniusFirebasePopupGuardInstalled';
  const win = window as unknown as Record<string, boolean>;
  if (!win[globalGuardKey]) {
    win[globalGuardKey] = true;
    window.addEventListener('unhandledrejection', (event) => {
      if (isFirebasePopupPendingPromiseError(event.reason)) {
        event.preventDefault();
      }
    });
  }
}

export interface GoogleSignInResult {
  firebaseUser: FirebaseUser;
  idToken: string;
}

let inFlightGoogleSignIn: Promise<GoogleSignInResult> | null = null;
let inFlightSignOut: Promise<void> | null = null;

function waitForRecoveredUser(timeoutMs: number = 900): Promise<FirebaseUser | null> {
  if (auth.currentUser) {
    return Promise.resolve(auth.currentUser);
  }
  return new Promise((resolve) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (!settled) {
        settled = true;
        unsubscribe();
        resolve(auth.currentUser);
      }
    }, timeoutMs);

    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user && !settled) {
        settled = true;
        window.clearTimeout(timer);
        unsubscribe();
        resolve(user);
      }
    });
  });
}

export function signInWithGooglePopup(): Promise<GoogleSignInResult> {
  // Deduplicate overlapping clicks so PopupOperation.currentPopupAction.cancel() is never
  // triggered mid-flight, which can otherwise race with an arriving OAuth event.
  if (inFlightGoogleSignIn) {
    return inFlightGoogleSignIn;
  }

  // Invoke signInWithPopup synchronously within the user's click activation (no prior await).
  const popupPromise = signInWithPopup(
    auth,
    googleAuthProvider,
    browserPopupRedirectResolver
  );

  inFlightGoogleSignIn = popupPromise
    .then(async (credential) => {
      const idToken = await credential.user.getIdToken();
      return {
        firebaseUser: credential.user,
        idToken,
      };
    })
    .catch(async (err: unknown) => {
      const code =
        err && typeof err === 'object' && 'code' in err
          ? String((err as { code?: unknown }).code)
          : '';
      const mayHaveCompletedInBackground =
        code === 'auth/popup-closed-by-user' ||
        code === 'auth/cancelled-popup-request' ||
        isFirebasePopupPendingPromiseError(err);

      if (mayHaveCompletedInBackground) {
        const recovered = await waitForRecoveredUser(900);
        if (recovered) {
          const idToken = await recovered.getIdToken();
          return {
            firebaseUser: recovered,
            idToken,
          };
        }
      }
      throw err;
    })
    .finally(() => {
      inFlightGoogleSignIn = null;
    });

  return inFlightGoogleSignIn;
}

export async function signOutFirebase(): Promise<void> {
  if (inFlightSignOut) {
    return inFlightSignOut;
  }
  inFlightSignOut = signOut(auth).finally(() => {
    inFlightSignOut = null;
  });
  return inFlightSignOut;
}
