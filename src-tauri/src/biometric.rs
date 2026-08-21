//! Touch ID–gated storage for AI API keys on macOS.
//!
//! The `keyring` crate stores secrets in the legacy file-based keychain,
//! which has no biometric support: every read pops the "allow access?"
//! panel and the *Always Allow* choice is tied to the app's code
//! signature (so unsigned dev builds re-prompt after every rebuild).
//!
//! This module instead writes to the **data-protection keychain** with a
//! `SecAccessControl` requiring user presence — Touch ID, falling back to
//! the login password. Reads then authenticate with a fingerprint rather
//! than an allow/deny prompt.
//!
//! `userPresence` is deliberate over `biometryCurrentSet`: the latter
//! invalidates the stored item whenever the enrolled fingerprints change,
//! which would silently lose the key. With `userPresence` the passcode is
//! always a way back in.
//!
//! Everything here is `#[cfg(target_os = "macos")]`; other platforms get
//! stubs that report "unsupported" so callers can fall back to `keyring`.

#[cfg(target_os = "macos")]
mod imp {
    use core_foundation::base::{CFType, CFTypeRef, TCFType};
    use core_foundation::data::CFData;
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_foundation::error::CFErrorRef;
    use core_foundation::string::{CFString, CFStringRef};
    use std::ptr;

    type OSStatus = i32;
    type CFAllocatorRef = *const std::os::raw::c_void;
    type SecAccessControlRef = *const std::os::raw::c_void;
    type CFOptionFlags = usize;

    const ERR_SEC_SUCCESS: OSStatus = 0;
    const ERR_SEC_ITEM_NOT_FOUND: OSStatus = -25300;
    const ERR_SEC_DUPLICATE_ITEM: OSStatus = -25299;
    const ERR_SEC_USER_CANCELED: OSStatus = -128;
    const ERR_SEC_AUTH_FAILED: OSStatus = -25293;

    /// Touch ID or the device passcode. (kSecAccessControlUserPresence)
    const ACCESS_CONTROL_USER_PRESENCE: CFOptionFlags = 1 << 0;

    #[link(name = "Security", kind = "framework")]
    extern "C" {
        static kSecClass: CFStringRef;
        static kSecClassGenericPassword: CFStringRef;
        static kSecAttrService: CFStringRef;
        static kSecAttrAccount: CFStringRef;
        static kSecValueData: CFStringRef;
        static kSecReturnData: CFStringRef;
        static kSecMatchLimit: CFStringRef;
        static kSecMatchLimitOne: CFStringRef;
        static kSecAttrAccessControl: CFStringRef;
        static kSecUseDataProtectionKeychain: CFStringRef;
        static kSecUseOperationPrompt: CFStringRef;
        static kSecAttrAccessibleWhenUnlockedThisDeviceOnly: CFStringRef;

        fn SecItemAdd(attributes: CFDictionaryRef, result: *mut CFTypeRef) -> OSStatus;
        fn SecItemCopyMatching(query: CFDictionaryRef, result: *mut CFTypeRef) -> OSStatus;
        fn SecItemDelete(query: CFDictionaryRef) -> OSStatus;
        fn SecAccessControlCreateWithFlags(
            allocator: CFAllocatorRef,
            protection: CFTypeRef,
            flags: CFOptionFlags,
            error: *mut CFErrorRef,
        ) -> SecAccessControlRef;
    }

    /// Wrap a framework CFStringRef constant without taking ownership.
    unsafe fn key(r: CFStringRef) -> CFType {
        CFString::wrap_under_get_rule(r).as_CFType()
    }

    /// The (service, account) pair identifying one stored secret.
    unsafe fn identity(service: &str, account: &str) -> Vec<(CFType, CFType)> {
        vec![
            (key(kSecClass), key(kSecClassGenericPassword)),
            (
                key(kSecAttrService),
                CFString::new(service).as_CFType(),
            ),
            (
                key(kSecAttrAccount),
                CFString::new(account).as_CFType(),
            ),
            // opt into the modern keychain; without this the item lands in
            // the legacy one and access control is ignored
            (
                key(kSecUseDataProtectionKeychain),
                core_foundation::boolean::CFBoolean::true_value().as_CFType(),
            ),
        ]
    }

    fn status_to_err(what: &str, status: OSStatus) -> String {
        match status {
            ERR_SEC_USER_CANCELED => "Authentication cancelled.".to_string(),
            ERR_SEC_AUTH_FAILED => "Touch ID authentication failed.".to_string(),
            other => format!("{what} failed (OSStatus {other})"),
        }
    }

    /// True when an access-control object requiring user presence can be
    /// created — a decent proxy for "this Mac can gate on Touch ID or a
    /// passcode" without linking LocalAuthentication.
    pub fn available() -> bool {
        unsafe {
            let mut error: CFErrorRef = ptr::null_mut();
            let ac = SecAccessControlCreateWithFlags(
                ptr::null(),
                kSecAttrAccessibleWhenUnlockedThisDeviceOnly as CFTypeRef,
                ACCESS_CONTROL_USER_PRESENCE,
                &mut error,
            );
            if ac.is_null() {
                return false;
            }
            core_foundation::base::CFRelease(ac as CFTypeRef);
            true
        }
    }

    /// Store (or replace) a secret behind Touch ID.
    pub fn set(service: &str, account: &str, secret: &str) -> Result<(), String> {
        // a replace is delete-then-add; ignore "wasn't there"
        let _ = delete(service, account);

        unsafe {
            let mut error: CFErrorRef = ptr::null_mut();
            let access = SecAccessControlCreateWithFlags(
                ptr::null(),
                kSecAttrAccessibleWhenUnlockedThisDeviceOnly as CFTypeRef,
                ACCESS_CONTROL_USER_PRESENCE,
                &mut error,
            );
            if access.is_null() {
                return Err("could not create a Touch ID access policy".to_string());
            }
            let access = CFType::wrap_under_create_rule(access as CFTypeRef);

            let mut pairs = identity(service, account);
            pairs.push((
                key(kSecValueData),
                CFData::from_buffer(secret.as_bytes()).as_CFType(),
            ));
            pairs.push((key(kSecAttrAccessControl), access));

            let attrs = CFDictionary::from_CFType_pairs(&pairs);
            let status = SecItemAdd(attrs.as_concrete_TypeRef(), ptr::null_mut());
            match status {
                ERR_SEC_SUCCESS => Ok(()),
                ERR_SEC_DUPLICATE_ITEM => Err("a key is already stored".to_string()),
                other => Err(status_to_err("storing the key", other)),
            }
        }
    }

    /// Read a secret, prompting for Touch ID. `Ok(None)` means nothing is
    /// stored (no prompt shown); `Err` means the user cancelled or failed.
    pub fn get(service: &str, account: &str, prompt: &str) -> Result<Option<String>, String> {
        unsafe {
            let mut pairs = identity(service, account);
            pairs.push((
                key(kSecReturnData),
                core_foundation::boolean::CFBoolean::true_value().as_CFType(),
            ));
            pairs.push((key(kSecMatchLimit), key(kSecMatchLimitOne)));
            pairs.push((
                key(kSecUseOperationPrompt),
                CFString::new(prompt).as_CFType(),
            ));

            let query = CFDictionary::from_CFType_pairs(&pairs);
            let mut result: CFTypeRef = ptr::null();
            let status = SecItemCopyMatching(query.as_concrete_TypeRef(), &mut result);
            match status {
                ERR_SEC_SUCCESS => {
                    if result.is_null() {
                        return Ok(None);
                    }
                    let data = CFData::wrap_under_create_rule(result as _);
                    let text = String::from_utf8(data.bytes().to_vec())
                        .map_err(|_| "stored key is not valid UTF-8".to_string())?;
                    Ok(Some(text))
                }
                ERR_SEC_ITEM_NOT_FOUND => Ok(None),
                other => Err(status_to_err("reading the key", other)),
            }
        }
    }

    /// Remove a stored secret. Deleting does not require authentication.
    pub fn delete(service: &str, account: &str) -> Result<(), String> {
        unsafe {
            let query = CFDictionary::from_CFType_pairs(&identity(service, account));
            let status = SecItemDelete(query.as_concrete_TypeRef());
            match status {
                ERR_SEC_SUCCESS | ERR_SEC_ITEM_NOT_FOUND => Ok(()),
                other => Err(status_to_err("removing the key", other)),
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    const UNSUPPORTED: &str = "Touch ID storage is only available on macOS";

    pub fn available() -> bool {
        false
    }

    pub fn set(_service: &str, _account: &str, _secret: &str) -> Result<(), String> {
        Err(UNSUPPORTED.to_string())
    }

    pub fn get(
        _service: &str,
        _account: &str,
        _prompt: &str,
    ) -> Result<Option<String>, String> {
        Ok(None)
    }

    pub fn delete(_service: &str, _account: &str) -> Result<(), String> {
        Ok(())
    }
}

pub use imp::{available, delete, get, set};
