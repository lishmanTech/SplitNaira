extern crate alloc;
use alloc::string::{String, ToString};

pub fn err(code: &str) -> String {
    code.to_string()
}
