use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let Some(dir) = args.next() else {
        eprintln!("usage: demo_home <dir> [--json]");
        return ExitCode::from(2);
    };
    let json = args.any(|a| a == "--json");
    match clonefleet_lib::demo::write_demo_home(&PathBuf::from(dir)) {
        Ok(env) => {
            let variables = env.variables();
            if json {
                let map: serde_json::Map<String, serde_json::Value> = variables
                    .into_iter()
                    .map(|(k, v)| (k.to_string(), serde_json::Value::String(v)))
                    .collect();
                println!("{}", serde_json::Value::Object(map));
            } else {
                for (key, value) in variables {
                    println!("{key}={value}");
                }
            }
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}
