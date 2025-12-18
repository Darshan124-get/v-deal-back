import admin from 'firebase-admin';

// Initialize Firebase Admin SDK
let firebaseInitialized = false;

export function initializeFirebase() {
  if (firebaseInitialized) {
    return;
  }

  try {
    const serviceAccountKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    
    if (!serviceAccountKey) {
      console.warn('FIREBASE_SERVICE_ACCOUNT_KEY not found in environment variables. FCM notifications will be disabled.');
      return;
    }

    let serviceAccount;
    try {
      // Parse the JSON string from environment variable
      serviceAccount = typeof serviceAccountKey === 'string' 
        ? JSON.parse(serviceAccountKey) 
        : serviceAccountKey;
    } catch (parseError) {
      console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT_KEY:', parseError.message);
      return;
    }

    // Initialize Firebase Admin SDK
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    firebaseInitialized = true;
    console.log('Firebase Admin SDK initialized successfully');
  } catch (error) {
    console.error('Failed to initialize Firebase Admin SDK:', error.message);
  }
}

/**
 * Send FCM notification to a teacher
 * @param {string} fcmToken - The FCM token of the teacher
 * @param {string} title - Notification title
 * @param {string} body - Notification body
 * @param {Object} data - Additional data payload (optional)
 * @returns {Promise<Object>} Result of the notification send
 */
export async function sendNotificationToTeacher(fcmToken, title, body, data = {}) {
  if (!firebaseInitialized) {
    console.warn('Firebase not initialized. Cannot send notification.');
    return { success: false, error: 'Firebase not initialized' };
  }

  if (!fcmToken) {
    console.warn('FCM token not provided. Cannot send notification.');
    return { success: false, error: 'FCM token not provided' };
  }

  try {
    const message = {
      token: fcmToken,
      notification: {
        title: title,
        body: body,
      },
      data: {
        ...data,
        // Convert all data values to strings (FCM requirement)
        ...Object.fromEntries(
          Object.entries(data).map(([key, value]) => [key, String(value)])
        ),
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'task_notifications',
          sound: 'default',
          priority: 'high',
        },
      },
    };

    const response = await admin.messaging().send(message);
    console.log('Successfully sent notification:', response);
    return { success: true, messageId: response };
  } catch (error) {
    console.error('Error sending FCM notification:', error);
    
    // Handle invalid token errors
    if (error.code === 'messaging/invalid-registration-token' || 
        error.code === 'messaging/registration-token-not-registered') {
      return { 
        success: false, 
        error: 'Invalid or unregistered FCM token',
        code: error.code 
      };
    }
    
    return { 
      success: false, 
      error: error.message || 'Failed to send notification',
      code: error.code 
    };
  }
}

/**
 * Send notification to multiple teachers
 * @param {Array<string>} fcmTokens - Array of FCM tokens
 * @param {string} title - Notification title
 * @param {string} body - Notification body
 * @param {Object} data - Additional data payload (optional)
 * @returns {Promise<Object>} Result of the batch notification send
 */
export async function sendNotificationToMultipleTeachers(fcmTokens, title, body, data = {}) {
  if (!firebaseInitialized) {
    console.warn('Firebase not initialized. Cannot send notifications.');
    return { success: false, error: 'Firebase not initialized' };
  }

  if (!fcmTokens || fcmTokens.length === 0) {
    console.warn('No FCM tokens provided. Cannot send notifications.');
    return { success: false, error: 'No FCM tokens provided' };
  }

  // Filter out null/undefined tokens
  const validTokens = fcmTokens.filter(token => token && token.trim() !== '');

  if (validTokens.length === 0) {
    return { success: false, error: 'No valid FCM tokens provided' };
  }

  try {
    const message = {
      notification: {
        title: title,
        body: body,
      },
      data: {
        ...data,
        // Convert all data values to strings (FCM requirement)
        ...Object.fromEntries(
          Object.entries(data).map(([key, value]) => [key, String(value)])
        ),
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'task_notifications',
          sound: 'default',
          priority: 'high',
        },
      },
    };

    const response = await admin.messaging().sendEachForMulticast({
      tokens: validTokens,
      ...message,
    });

    console.log(`Successfully sent ${response.successCount} notifications out of ${validTokens.length}`);
    
    return {
      success: true,
      successCount: response.successCount,
      failureCount: response.failureCount,
      responses: response.responses,
    };
  } catch (error) {
    console.error('Error sending batch FCM notifications:', error);
    return {
      success: false,
      error: error.message || 'Failed to send notifications',
    };
  }
}

