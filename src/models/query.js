import admin, {db} from '../services/firebase';

const docRef = await db.collection("Material").add({
    name: "Mwenda",
    email: "mwenda@example.com",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

/*
This function executes the creation of the notebook 
Input:notebook:obj,
notebook:{summary, title}
*/
export const createNotebookQuery = async (notebook) => {
    let now = admin.firestore.FieldValue.serverTimestamp();
    let userRef = db.collection('User').doc(notebook.userID);
    const notebookRef = await db.collection('Notebook').add({
        summary: notebook.summary,
        title: notebook.title,
        userID: userRef,
        dateCreated:now,
        dateUpdated:now
    });
    return notebookRef
}

/*
This function executes the creation of the material entry
Input:notebook:obj,
notebook:{summary, title}
*/
export const createMaterialQuery = async (notebookRef, materials) =>{
    let now = admin.firestore.FieldValue.serverTimestamp();   
    if(materials.length==1){
        const materialRef = await db.collection('Material').add(
            {
                notebookID:notebookRef,
                status:'processed',
                storagePath:materials[0].name,
                dateCreated:now
            }
        )
        console.log('Material addes successfully');
    }else{
        const batch = db.batch();
        materials.forEach(async (material) => {
            const materialRef = db.collection('Material').doc();
            const materialDoc = 
                {
                    notebookID:notebookRef,
                    name:material.name,
                    status:'processed',
                    storagePath:material.name,
                    dateCreated:now
                }
            batch.set(materialRef, materialDoc);

        });
        await batch.commit();
        console.log('batch documents uploaded successfully');
    }
}