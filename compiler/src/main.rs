const PROGRAM: &'static str = r#"
(vec
    (let A (read_int))
    (let B (read_int))
    (let C (read_int))
    (let S (read_str))
    (println (sum A B C) S)
)
"#;

pub fn main() {
    compiler::eval_with_stdio(PROGRAM.into());
}

pub mod compiler {
    use std::collections::BTreeMap;
    use std::fmt::{self, Display, Write as FmtWrite};
    use std::io::{self, Write as IoWrite};
    use std::str;

    const PUNS: &'static [&'static [u8]] = &[
        b"(", b")", b"[", b"]", b"{", b"}", b"++=", b"+=", b"-=", b"*=", b"/=", b"%=", b"==",
        b"!=", b"++", b"+", b"-", b"*", b"/", b"%", b"=", b":",
    ];

    const EOF: &'static Tok = &Tok::Eof;

    type TokId = usize;
    type SynId = usize;
    type Range = (usize, usize);
    type Toks = Vec<(Tok, Range)>;
    type Doc = (Vec<u8>, Toks, Vec<Syn>);

    #[derive(Clone, PartialEq, Debug)]
    enum Tok {
        Err(String),
        Id(String),
        Int(i64),
        Str(String),
        Pun(&'static [u8]),
        Eof,
    }

    #[derive(Clone, PartialEq, Debug)]
    enum Syn {
        Err(String, TokId),
        Val(TokId),
        App(Vec<SynId>),
    }

    // enum Exp {
    //     Val(TokId),
    //     Pun(&'static str),
    //     App(SynId, Vec<Exp>),
    // }

    #[derive(Clone, PartialEq, Debug)]
    enum Val {
        Id(String),
        Int(i64),
        Num(f64),
        Str(Vec<u8>),
        Vec(Vec<Val>),
    }

    impl Display for Val {
        fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
            match self {
                &Val::Id(ref value) => f.write_fmt(format_args!("{}", value)),
                &Val::Int(value) => f.write_fmt(format_args!("{}", value)),
                &Val::Num(value) => f.write_fmt(format_args!("{}", value)),
                &Val::Str(ref value) => {
                    f.write_fmt(format_args!("{}", String::from_utf8_lossy(value)))
                }
                &Val::Vec(ref value) => {
                    f.write_char('[')?;
                    for item in value {
                        f.write_fmt(format_args!("{}", item))?;
                    }
                    f.write_char(']')?;
                    return Ok(());
                }
            }
        }
    }

    pub struct Tokenizer {
        src: Vec<u8>,
        cur: usize,
        toks: Vec<(Tok, (usize, usize))>,
    }

    fn is_ascii_digit(c: u8) -> bool {
        b'0' <= c && c <= b'9'
    }

    fn is_id_char(c: u8) -> bool {
        b'a' <= c && c <= b'z' || b'A' <= c && c <= b'Z' || c == b'_' || is_ascii_digit(c)
    }

    fn is_whitespace(c: u8) -> bool {
        c == b' ' || c == b'\r' || c == b'\n'
    }

    impl Tokenizer {
        fn c(&self) -> u8 {
            if self.cur >= self.src.len() {
                return 0;
            }
            self.src[self.cur]
        }

        fn take<P: Fn(u8) -> bool>(&mut self, pred: P) -> Option<(String, (usize, usize))> {
            let l = self.cur;
            if !pred(self.c()) {
                return None;
            }
            while pred(self.c()) {
                self.cur += 1;
            }
            let r = self.cur;
            Some((String::from_utf8_lossy(&self.src[l..r]).into(), (l, r)))
        }

        fn followed_by(&mut self, prefix: &[u8]) -> bool {
            if self.src[self.cur..].starts_with(prefix) {
                self.cur += prefix.len();
                return true;
            }
            false
        }

        fn tokenize(mut self) -> Vec<(Tok, (usize, usize))> {
            let l = self.cur;
            't: while self.cur < self.src.len() {
                if let Some(_) = self.take(is_whitespace) {
                    continue;
                }
                if let Some((word, range)) = self.take(is_ascii_digit) {
                    self.toks.push((Tok::Int(word.parse().unwrap_or(0)), range));
                    continue;
                }
                if let Some((word, range)) = self.take(is_id_char) {
                    self.toks.push((Tok::Id(word.into()), range));
                    continue;
                }
                if self.c() == b'"' {
                    self.cur += 1;
                    let (word, (l, r)) = self.take(|c| c != b'"' && c != b'\n' && c != 0).unwrap();
                    self.cur += 1;
                    self.toks.push((Tok::Str(word.into()), (l + 1, r + 1)));
                    continue;
                }
                if self.followed_by(b"//") {
                    self.take(|c| c != b'\n');
                    continue;
                }
                for pun in PUNS {
                    if self.followed_by(pun) {
                        self.toks.push((Tok::Pun(pun), (l, self.cur)));
                        continue 't;
                    }
                }
                self.cur += 1;
                self.toks.push((Tok::Err("?".into()), (l, self.cur)));
            }
            self.toks.push((Tok::Eof, (self.cur, self.cur)));
            self.toks
        }
    }

    pub struct Parser {
        toks: Toks,
        cur: usize,
        reads: Vec<(String, String)>,
        syns: Vec<Syn>,
    }

    impl Parser {
        fn next(&self) -> &Tok {
            if self.cur >= self.toks.len() {
                return EOF;
            }
            &self.toks[self.cur].0
        }

        fn next_is_opening(&self) -> bool {
            match self.next() {
                &Tok::Pun(b"(") | &Tok::Pun(b"[") | &Tok::Pun(b"{") => true,
                _ => false,
            }
        }

        fn next_is_closing(&self) -> bool {
            match self.next() {
                &Tok::Pun(b")") | &Tok::Pun(b"]") | &Tok::Pun(b"}") => true,
                _ => false,
            }
        }

        fn push(&mut self, syn: Syn) -> SynId {
            let syn_id = self.syns.len();
            self.syns.push(syn);
            syn_id
        }

        fn read_exp(&mut self) -> SynId {
            let tok_id = self.cur;

            if self.next_is_opening() {
                self.cur += 1;
                let mut children = vec![];
                while !self.next_is_closing() && *self.next() != Tok::Eof {
                    children.push(self.read_exp());
                }
                if *self.next() != Tok::Eof {
                    self.cur += 1;
                }
                return self.push(Syn::App(children));
            }
            if self.next_is_closing() {
                self.cur += 1;
                return self.push(Syn::Err("Unmatched bracket".into(), tok_id));
            }

            self.cur += 1;
            self.push(Syn::Val(tok_id))
        }

        fn parse(mut self) -> Vec<Syn> {
            self.read_exp();
            self.syns
        }
    }

    pub struct Evaluator<R, W> {
        doc: Doc,
        env: BTreeMap<String, Val>,
        stdin_line: String,
        stdin_words: Vec<String>,
        stdin: R,
        stdout: W,
    }

    impl<R: io::BufRead, W: IoWrite> Evaluator<R, W> {
        fn next_word(&mut self) -> String {
            for _ in 0..10 {
                if let Some(word) = self.stdin_words.pop() {
                    return word;
                }

                self.stdin_line.clear();
                self.stdin.read_line(&mut self.stdin_line).unwrap();
                self.stdin_words
                    .extend(self.stdin_line.split_whitespace().map(String::from).rev());
            }
            panic!("Expected a word but not given.");
        }

        fn toks(&self) -> &[(Tok, Range)] {
            &self.doc.1
        }

        fn syns(&self) -> &[Syn] {
            &self.doc.2
        }

        fn app_item(&self, syn_id: SynId, i: usize) -> SynId {
            if let &Syn::App(ref items) = &self.syns()[syn_id] {
                return items[i];
            }
            unreachable!()
        }

        fn app_len(&self, syn_id: SynId) -> usize {
            if let &Syn::App(ref items) = &self.syns()[syn_id] {
                return items.len();
            }
            0
        }

        fn do_app(&mut self, stack: &mut Vec<Val>, len: usize) {
            if len == 0 {
                return;
            }

            let mut values = vec![];
            for _ in 1..len {
                values.push(stack.pop().unwrap());
            }
            values.reverse();
            let head = stack.pop().unwrap();

            match &head {
                &Val::Id(ref id) => {
                    if id == "read_int" {
                        stack.push(Val::Int(self.next_word().parse().unwrap()));
                        return;
                    }
                    if id == "read_str" {
                        stack.push(Val::Str(self.next_word().as_bytes().to_owned()));
                        return;
                    }
                    if id == "println" {
                        for val in values {
                            write!(self.stdout, "{} ", val).unwrap();
                        }
                        writeln!(self.stdout, "").unwrap();
                        stack.push(Val::Int(0));
                        return;
                    }
                    if id == "sum" {
                        let mut sum = 0;
                        println!("{:?}", values);
                        for i in 0..values.len() {
                            match &values[i] {
                                &Val::Int(value) => sum += value,
                                _ => panic!("sum's argument must be integers"),
                            }
                        }
                        stack.push(Val::Int(sum));
                        return;
                    }
                    if id == "join" {
                        let sep = match &values[0] {
                            &Val::Str(ref sep) => sep,
                            _ => panic!("join's first argument must be a str"),
                        };
                        let mut buf = Vec::new();
                        for i in 1..values.len() {
                            if i > 1 {
                                buf.write(sep).unwrap();
                            }
                            write!(buf, "{}", values[i]).unwrap();
                        }
                        stack.push(Val::Str(buf));
                        return;
                    }
                    if id == "let" {
                        match (&values[0], &values[1]) {
                            (&Val::Id(ref name), val) => {
                                self.env.insert(name.to_owned(), (*val).clone());
                                stack.push((*val).clone());
                            }
                            _ => panic!("let's first param must be id"),
                        }
                        return;
                    }
                    if id == "vec" {
                        stack.push(Val::Vec(values));
                        return;
                    }
                    panic!("unknown identifier");
                }
                _ => panic!("head must be an identifier"),
            }
        }

        fn eval_exp(&mut self, stack: &mut Vec<Val>, syn_id: usize) {
            println!("eval {} {:?}", syn_id, &self.syns()[syn_id]);

            match &self.syns()[syn_id] {
                &Syn::Err(ref err, _) => panic!("{}", err),
                &Syn::Val(tok_id) => match &self.toks()[tok_id].0 {
                    &Tok::Err(ref err) => panic!("{}", err),
                    &Tok::Id(ref id) => {
                        if let Some(val) = self.env.get(id) {
                            stack.push((*val).clone());
                            return;
                        }
                        stack.push(Val::Id(id.to_owned()));
                        return;
                    }
                    &Tok::Int(value) => stack.push(Val::Int(value)),
                    &Tok::Str(ref value) => stack.push(Val::Str((&*value).as_bytes().to_owned())),
                    &Tok::Pun(_) => return,
                    &Tok::Eof => return,
                },
                &Syn::App(_) => {}
            }

            let len = self.app_len(syn_id);
            for i in 0..len {
                let item = self.app_item(syn_id, i);
                self.eval_exp(stack, item);
            }
            self.do_app(stack, len);
        }

        fn eval(mut self) {
            let mut stack = vec![Val::Int(0)];
            let syn_id = self.syns().len() - 1;
            self.eval_exp(&mut stack, syn_id);
        }
    }

    fn parse(src: &str) -> Doc {
        let src = src.as_bytes().to_owned();
        let toks = Tokenizer {
            src: src.clone(),
            toks: vec![],
            cur: 0,
        }
        .tokenize();
        let syns = Parser {
            toks: toks.clone(),
            cur: 0,
            reads: vec![],
            syns: vec![],
        }
        .parse();
        (src, toks, syns)
    }

    pub fn eval(source: &str, stdin: String) -> String {
        let mut stdout = Vec::new();

        let doc = parse(source);
        Evaluator {
            doc: doc,
            env: BTreeMap::new(),
            stdin_line: String::new(),
            stdin_words: Vec::new(),
            stdin: io::BufReader::new(io::Cursor::new(&stdin)),
            stdout: io::BufWriter::new(&mut stdout),
        }
        .eval();

        String::from_utf8(stdout).unwrap()
    }

    pub fn eval_with_stdio(src: String) {
        let stdin = io::stdin();
        let stdin = io::BufReader::new(stdin.lock());
        let stdout = io::stdout();
        let stdout = io::BufWriter::new(stdout.lock());
        let doc = parse(&src);
        println!("{:?}\n{:?}", doc.1, doc.2);
        Evaluator {
            doc: doc,
            env: BTreeMap::new(),
            stdin_line: String::new(),
            stdin_words: Vec::new(),
            stdin: stdin,
            stdout: stdout,
        }
        .eval();
    }
}
