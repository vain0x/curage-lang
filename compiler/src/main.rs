use std::io::{stdin, stdout, BufRead, BufReader, BufWriter, Write};
use std::*;

#[derive(Debug)]
enum Val {
    Int(i64),
    Str(String),
}

struct Evaluator<R, W> {
    source: String,
    line: String,
    input: R,
    input_words: Vec<String>,
    output: W,
}

impl<R: BufRead, W: Write> Evaluator<R, W> {
    fn next_word(&mut self) -> String {
        loop {
            if let Some(word) = self.input_words.pop() {
                return word;
            }

            self.input.read_line(&mut self.line).unwrap();
            self.input_words
                .extend(self.line.split_whitespace().rev().map(String::from));
        }
    }

    fn eval(mut self) {
        let mut stack = vec![];

        for line in self.source.lines().map(String::from).collect::<Vec<_>>() {
            if line == "read_int" {
                let word = self.next_word();
                let value = word.parse().unwrap();
                stack.push(Val::Int(value));
            } else if line == "println" {
                println!("{:?}", stack.pop().unwrap());
            }
        }
    }
}

fn main() {
    let stdin = stdin();
    let stdin = BufReader::new(stdin.lock());
    let stdout = stdout();
    let stdout = Box::new(BufWriter::new(stdout.lock()));
    let line = String::new();
    let source = String::from("read_int\nprintln");

    let evaluator = Evaluator {
        source: source,
        line: line,
        input: stdin,
        input_words: vec![],
        output: stdout,
    };

    evaluator.eval();
}
