import { getApp, getApps, initializeApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type Unsubscribe,
  type User,
} from 'firebase/auth';
import {
  doc,
  getDocFromServer,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  type Firestore,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

export const AUTHORIZED_ADMIN_EMAIL = 'wwwomara6@gmail.com';

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: Array<{
      providerId?: string | null;
      email?: string | null;
    }>;
  };
}

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

let firestoreInstance: Firestore;
try {
  firestoreInstance = initializeFirestore(
    app,
    {
      localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager(),
      }),
    },
    firebaseConfig.firestoreDatabaseId
  );
} catch {
  // Fallback if Firestore was already initialized in hot reload / tests
  firestoreInstance = initializeFirestore(
    app,
    {},
    firebaseConfig.firestoreDatabaseId
  );
}

export const db = firestoreInstance;
export const auth = getAuth(app);

export function isAuthorizedAdminUser(user: User | null | undefined): boolean {
  if (!user) return false;
  return (
    user.emailVerified === true &&
    (user.email ?? '').trim().toLowerCase() === AUTHORIZED_ADMIN_EMAIL
  );
}

export async function signInAdminWithGoogle(): Promise<User> {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({
    login_hint: AUTHORIZED_ADMIN_EMAIL,
    prompt: 'select_account',
  });
  const credential = await signInWithPopup(auth, provider);
  if (!isAuthorizedAdminUser(credential.user)) {
    await signOut(auth);
    throw new Error(
      `الحساب غير مخوّل للإدارة. الحساب المصرّح له حصراً هو ${AUTHORIZED_ADMIN_EMAIL}.`
    );
  }
  return credential.user;
}

export async function signOutAdmin(): Promise<void> {
  await signOut(auth);
}

export function subscribeAdminAuth(
  callback: (state: { ready: boolean; user: User | null; isAdmin: boolean }) => void
): Unsubscribe {
  return onAuthStateChanged(auth, (user) => {
    callback({
      ready: true,
      user,
      isAdmin: isAuthorizedAdminUser(user),
    });
  });
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const currentUser = auth.currentUser;
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    operationType,
    path,
    authInfo: {
      userId: currentUser?.uid ?? null,
      email: currentUser?.email ?? null,
      emailVerified: currentUser?.emailVerified ?? null,
      isAnonymous: currentUser?.isAnonymous ?? null,
      tenantId: currentUser?.tenantId ?? null,
      providerInfo:
        currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) ?? [],
    },
  };
  console.error('Firestore Error:', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export async function testConnection(): Promise<{
  connected: boolean;
  offline: boolean;
  error?: string;
}> {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    return { connected: true, offline: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const offline = message.includes('the client is offline');
    if (offline) {
      console.error('Please check your Firebase configuration.');
    }
    return { connected: false, offline, error: message };
  }
}
