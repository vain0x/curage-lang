include!{"./main.rs"}

#[cfg(test)]
mod tests {
    use compiler;

    #[test]
    fn test() {
        assert_eq!(compiler::eval("read_int\nprintln", "42".into()), "42\n");
    }
}
