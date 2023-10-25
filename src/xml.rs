use std::collections::HashMap;

pub struct XMLBuilder {
    name: String,
    value: Option<String>,
    attributes: Option<HashMap<String, String>>,
    elements: Vec<XMLBuilder>,
}

impl XMLBuilder {
    pub fn new(
        name: String,
        attributes: Option<Vec<(String, String)>>,
        value: Option<String>,
    ) -> XMLBuilder {
        XMLBuilder {
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
    ) -> &mut XMLBuilder {
        let el = XMLBuilder::new(name, attributes, value);
        self.elements.push(el);
        self.elements.last_mut().unwrap()
    }

    pub fn add(&mut self, element: XMLBuilder) {
        self.elements.push(element);
    }

    pub fn build(&self) -> String {
        let mut xml = Vec::new();
        xml.push("<?xml version=\"1.0\" encoding=\"utf-8\"?>".to_string());
        xml.push(self.write_element(self));
        xml.join("")
    }

    fn write_element(&self, element: &XMLBuilder) -> String {
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
}

#[cfg(test)]
mod tests {
    use crate::xml::XMLBuilder;

    #[test]
    fn xml_build() {
        let mut xml = XMLBuilder::new("root".to_string(), None, None);
        xml.elem("child".to_string(), None, None)
            .elem("grandchild".to_string(), None, None)
            .add(XMLBuilder::new(
                "greatgrandchild".to_string(),
                None,
                Some("value".to_string()),
            ));
        assert!(xml.build() == "<?xml version=\"1.0\" encoding=\"utf-8\"?><root><child><grandchild><greatgrandchild>value</greatgrandchild></grandchild></child></root>")
    }
}
