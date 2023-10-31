use quick_xml::events::Event;
use quick_xml::reader::Reader;
use std::collections::HashMap;

#[derive(Default, Debug, Clone)]
pub struct XMLNode {
    pub name: String,
    pub value: Option<String>,
    pub attributes: Option<HashMap<String, String>>,
    pub elements: Vec<XMLNode>,
}

impl XMLNode {
    pub fn new(
        name: String,
        attributes: Option<Vec<(String, String)>>,
        value: Option<String>,
    ) -> XMLNode {
        XMLNode {
            name,
            value,
            attributes: attributes.map(|v| v.into_iter().collect()),
            elements: Vec::new(),
        }
    }

    pub fn elem(
        &mut self,
        name: String,
        attributes: Option<Vec<(String, String)>>,
        value: Option<String>,
    ) -> &mut XMLNode {
        let el = XMLNode::new(name, attributes, value);
        self.elements.push(el);
        self.elements.last_mut().unwrap()
    }

    pub fn add(&mut self, element: XMLNode) {
        self.elements.push(element);
    }

    pub fn build(&self) -> String {
        let mut xml = Vec::new();
        xml.push("<?xml version=\"1.0\" encoding=\"utf-8\"?>".to_string());
        xml.push(self.write_element(self));
        xml.join("")
    }

    fn write_element(&self, element: &XMLNode) -> String {
        let mut xml = Vec::new();
        // attributes
        let mut attrs = Vec::new();
        if let Some(attributes) = &element.attributes {
            for (key, value) in attributes {
                attrs.push(format!("{}=\"{}\"", key, value));
            }
        }
        if !attrs.is_empty() {
            xml.push(format!("<{} {}>", element.name, attrs.join(" ")));
        } else {
            xml.push(format!("<{}>", element.name));
        }
        // value
        if let Some(value) = &element.value {
            xml.push(value.clone());
        }
        // elements
        for item in &element.elements {
            xml.push(self.write_element(item));
        }
        // end tag
        xml.push(format!("</{}>", element.name));
        xml.join("")
    }

    pub fn parse_xml(xml: &str) -> Result<XMLNode, String> {
        let mut reader = Reader::from_str(xml);
        reader.trim_text(true);
        let mut buf = Vec::new();
        let mut elements: Vec<XMLNode> = Vec::new();
        let mut stack: Vec<(String, HashMap<String, String>, String)> = Vec::new();
        loop {
            match reader.read_event_into(&mut buf) {
                Ok(Event::Start(ref e)) => {
                    stack.push((
                        std::str::from_utf8(e.name().as_ref()).unwrap().to_string(),
                        e.attributes()
                            .map(|a| {
                                let a = a.unwrap();
                                (
                                    std::str::from_utf8(a.key.as_ref()).unwrap().to_string(),
                                    std::str::from_utf8(a.value.as_ref()).unwrap().to_string(),
                                )
                            })
                            .collect(),
                        "".to_string(),
                    ));
                }
                Ok(Event::End(_)) => {
                    stack.pop().map(|(name, attributes, value)| {
                        let mut element =
                            XMLNode::new(name, Some(attributes.into_iter().collect()), Some(value));
                        match elements.pop() {
                            None => {
                                let _ = &elements.push(element.clone());
                            }
                            Some(c) => {
                                element.add(c);
                                let _ = &elements.push(element);
                            }
                        };
                    });
                }
                Ok(Event::Text(e)) => {
                    stack.pop().map(|(name, attributes, _)| {
                        stack.push((name, attributes, e.unescape().unwrap().into_owned()));
                    });
                }
                Ok(Event::Eof) => break,
                Err(e) => {
                    return Err(format!(
                        "Error at position {}: {:?}",
                        reader.buffer_position(),
                        e
                    ))
                }
                _ => (),
            }
            buf.clear();
        }
        if elements.len() == 1 {
            Ok(elements.pop().unwrap())
        } else {
            Err(format!("XMLNode parse error, {:?}", elements))
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::xml::XMLNode;

    #[test]
    fn xml_build() {
        let mut xml = XMLNode::new("root".to_string(), None, None);
        xml.elem("child".to_string(), None, None)
            .elem("grandchild".to_string(), None, None)
            .add(XMLNode::new(
                "greatgrandchild".to_string(),
                None,
                Some("value".to_string()),
            ));
        assert!(xml.build() == "<?xml version=\"1.0\" encoding=\"utf-8\"?><root><child><grandchild><greatgrandchild>value</greatgrandchild></grandchild></child></root>")
    }

    #[test]
    fn xml_parse() {
        let xml = "<?xml version=\"1.0\" encoding=\"utf-8\"?><root><child><grandchild><greatgrandchild>value</greatgrandchild></grandchild></child></root>";
        let xml = XMLNode::parse_xml(xml).unwrap();
        assert!(xml.build() == "<?xml version=\"1.0\" encoding=\"utf-8\"?><root><child><grandchild><greatgrandchild>value</greatgrandchild></grandchild></child></root>", "{}", xml.build())
    }
}
